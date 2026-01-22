import { Auth } from "@/auth"
import type { Config } from "@/config/config"
import { Instance } from "@/project/instance"

export type ProviderPool = NonNullable<NonNullable<Config.Info["provider"]>[string]["pool"]>
type ProviderPoolEntry = NonNullable<ProviderPool["entries"]>[number]

export type ResolvedPoolEntry = {
  entryId: string
  label?: string
  baseURL: string
  apiKey: string
}

type PoolState = {
  selectedBySession: Map<string, string>
  bannedBySession: Map<string, Set<string>>
  lastUsedAt: Map<string, number>
}

const state = Instance.state<PoolState>(() => ({
  selectedBySession: new Map(),
  bannedBySession: new Map(),
  lastUsedAt: new Map(),
}))

function isValidBaseUrl(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function normalizeEntry(entry: ProviderPoolEntry) {
  const enabled = entry.enabled !== false
  const weight = entry.weight ?? 1
  return {
    entryId: entry.entryId,
    label: entry.label,
    baseURL: entry.baseURL,
    enabled,
    weight,
  }
}

function sessionProviderKey(sessionID: string, providerID: string) {
  return `${sessionID}/${providerID}`
}

function entryKey(providerID: string, entryId: string) {
  return `${providerID}/${entryId}`
}

function selectLeastRecentlyUsed(providerID: string, candidates: Array<ReturnType<typeof normalizeEntry>>) {
  const s = state()
  let best: (typeof candidates)[number] | undefined
  let bestUsedAt = Infinity
  for (const candidate of candidates) {
    const usedAt = s.lastUsedAt.get(entryKey(providerID, candidate.entryId)) ?? 0
    if (best === undefined || usedAt < bestUsedAt) {
      best = candidate
      bestUsedAt = usedAt
    }
  }
  return best
}

export async function resolvePoolEntry(input: {
  providerID: string
  pool: ProviderPool | undefined
  sessionID?: string
}): Promise<ResolvedPoolEntry | undefined> {
  const pool = input.pool
  if (!pool) return

  const policy = pool.policy ?? "metered"
  const affinity = pool.affinity ?? "session"
  const sessionID = input.sessionID ?? "global"

  const s = state()
  const banned = s.bannedBySession.get(sessionProviderKey(sessionID, input.providerID)) ?? new Set<string>()

  const secrets = await Auth.Pool.all()
  const providerSecrets = secrets[input.providerID] ?? {}

  const candidates = (pool.entries ?? [])
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry.enabled)
    .filter((entry) => isValidBaseUrl(entry.baseURL))
    .filter((entry) => Boolean(providerSecrets[entry.entryId]?.key))
    .filter((entry) => !banned.has(entry.entryId))

  if (candidates.length === 0) return

  if (affinity === "session") {
    const existing = s.selectedBySession.get(sessionProviderKey(sessionID, input.providerID))
    if (existing && candidates.some((candidate) => candidate.entryId === existing)) {
      const selected = candidates.find((candidate) => candidate.entryId === existing)!
      s.lastUsedAt.set(entryKey(input.providerID, selected.entryId), Date.now())
      return {
        entryId: selected.entryId,
        label: selected.label,
        baseURL: selected.baseURL,
        apiKey: providerSecrets[selected.entryId]!.key,
      }
    }
  }

  const selected =
    policy === "quota" ? selectLeastRecentlyUsed(input.providerID, candidates) : (candidates[0] ?? undefined)
  if (!selected) return

  s.lastUsedAt.set(entryKey(input.providerID, selected.entryId), Date.now())
  if (affinity === "session") {
    s.selectedBySession.set(sessionProviderKey(sessionID, input.providerID), selected.entryId)
  }

  return {
    entryId: selected.entryId,
    label: selected.label,
    baseURL: selected.baseURL,
    apiKey: providerSecrets[selected.entryId]!.key,
  }
}

export async function failoverPoolEntry(input: {
  providerID: string
  pool: ProviderPool | undefined
  sessionID?: string
}): Promise<ResolvedPoolEntry | undefined> {
  const pool = input.pool
  if (!pool) return

  const sessionID = input.sessionID ?? "global"
  const sessionKey = sessionProviderKey(sessionID, input.providerID)

  const s = state()
  const current = await resolvePoolEntry({ providerID: input.providerID, pool, sessionID })
  if (!current) return

  const banned = s.bannedBySession.get(sessionKey) ?? new Set<string>()
  banned.add(current.entryId)
  s.bannedBySession.set(sessionKey, banned)
  s.selectedBySession.delete(sessionKey)

  return resolvePoolEntry({ providerID: input.providerID, pool, sessionID })
}
