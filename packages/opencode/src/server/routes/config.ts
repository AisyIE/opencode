import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Auth } from "../../auth"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Global } from "../../global"
import { Instance } from "../../project/instance"
import { type ConfigEdit, ConfigFileEditError, resolveConfigPath, updateConfigFile } from "../../config/config-file"
import { type ParseError as JsoncParseError, parse as parseJsonc } from "jsonc-parser"

const log = Log.create({ service: "server" })

const PresetId = z.enum(["openai-responses", "openai-classic", "anthropic", "gemini"])
type PresetId = z.infer<typeof PresetId>
const PresetScope = z.enum(["global", "project"])

const PresetCatalog: Record<
  PresetId,
  {
    providerID: string
    defaultBaseURL: string
    npm: string
    useChatCompletions?: boolean
  }
> = {
  "openai-responses": {
    providerID: "openai",
    defaultBaseURL: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    useChatCompletions: false,
  },
  "openai-classic": {
    providerID: "openai",
    defaultBaseURL: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    useChatCompletions: true,
  },
  anthropic: {
    providerID: "anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
  },
  gemini: {
    providerID: "google",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    npm: "@ai-sdk/google",
  },
}

const BaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      return false
    }
  }, "Invalid baseURL")

const ProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((value) => !value.includes("/"), "Provider ID must not contain '/'")
  .refine((value) => /^[a-z][a-z0-9-_]*$/.test(value), "Provider ID must be a lowercase slug (a-z, 0-9, -, _)")

const PoolPolicy = z.enum(["metered", "quota"])
const PoolAffinity = z.enum(["session", "none"])

const OpenAIModelsResponse = z
  .object({
    data: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  })
  .passthrough()

async function discoverOpenAICompatibleModels(input: { baseURL: string; apiKey: string }) {
  const url = new URL("models", input.baseURL.endsWith("/") ? input.baseURL : `${input.baseURL}/`).toString()

  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    const hint = body ? `: ${body.slice(0, 200)}` : ""
    return { ok: false as const, error: `HTTP ${response.status}${hint}` }
  }

  const json = await response.json().catch(() => null)
  if (!json) return { ok: false as const, error: "Invalid JSON response" }

  const parsed = OpenAIModelsResponse.safeParse(json)
  if (!parsed.success) return { ok: false as const, error: "Unrecognized /models response format" }

  const ids = (parsed.data.data ?? []).map((item) => item.id).filter((id) => id && typeof id === "string")
  if (ids.length === 0) return { ok: false as const, error: "No models returned" }

  const unique = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
  return { ok: true as const, modelIDs: unique }
}

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.get())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .post(
      "/provider-presets/apply",
      describeRoute({
        summary: "Apply provider preset",
        description: "Apply a provider preset by writing config options and storing API key credentials.",
        operationId: "config.providerPresets.apply",
        responses: {
          200: {
            description: "Preset applied",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    providerID: z.string(),
                    scope: PresetScope,
                    configPath: z.string(),
                    modelsSynced: z.boolean().optional(),
                    syncError: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z
          .object({
            preset: PresetId,
            scope: PresetScope,
            baseURL: BaseUrlSchema,
            apiKey: z.string().trim().min(1),
            targetProviderID: ProviderIdSchema.optional(),
            targetProviderName: z.string().trim().min(1).optional(),
            syncModels: z.boolean().optional(),
          })
          .superRefine((value, ctx) => {
            if (value.targetProviderName && !value.targetProviderID) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "targetProviderName requires targetProviderID",
                path: ["targetProviderName"],
              })
            }
          }),
      ),
      async (c) => {
        const { preset, scope, baseURL, apiKey, targetProviderID, targetProviderName, syncModels } = c.req.valid("json")
        const presetInfo = PresetCatalog[preset]
        const providerID = targetProviderID ?? presetInfo.providerID

        const projectRoot = Instance.project.vcs === "git" ? Instance.worktree : Instance.directory
        const baseDir = scope === "global" ? Global.Path.config : projectRoot
        const configPath = await resolveConfigPath(baseDir, { includeDotOpencode: scope === "project" })

        let modelsSynced = false
        let syncError: string | undefined

        const edits: ConfigEdit[] = []
        if (targetProviderID) {
          edits.push(
            {
              path: ["provider", providerID, "name"],
              value: targetProviderName ?? providerID,
            },
            {
              path: ["provider", providerID, "npm"],
              value: presetInfo.npm,
            },
          )
        }
        edits.push(
          {
            path: ["provider", providerID, "options", "baseURL"],
            value: baseURL,
          },
        )
        if (presetInfo.useChatCompletions !== undefined) {
          edits.push({
            path: ["provider", providerID, "options", "useChatCompletions"],
            value: presetInfo.useChatCompletions,
          })
        }

        if (syncModels) {
          const discovered = await discoverOpenAICompatibleModels({ baseURL, apiKey })
          if (discovered.ok) {
            modelsSynced = true
            edits.push({ path: ["provider", providerID, "whitelist"], value: discovered.modelIDs })
          } else {
            syncError = `Model sync failed: ${discovered.error}`
          }
        }

        await Auth.set(providerID, { type: "api", key: apiKey })
        try {
          await updateConfigFile(configPath, edits, { ensureSchema: true })
        } catch (error) {
          await Auth.remove(providerID).catch(() => {})
          if (error instanceof ConfigFileEditError) {
            return c.json({ error: `${error.message}: ${error.path}` }, 400)
          }
          return c.json({ error: "Failed to update config file" }, 400)
        }

        return c.json({
          ok: true,
          providerID,
          scope,
          configPath,
          ...(syncModels ? { modelsSynced, syncError } : {}),
        })
      },
    )
    .post(
      "/provider-key-pools/entries/apply",
      describeRoute({
        summary: "Upsert provider key pool entry",
        description: "Upsert a provider key pool entry in config. Secrets are stored separately in the auth store.",
        operationId: "config.providerKeyPools.entries.apply",
        responses: {
          200: {
            description: "Entry applied",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    providerID: z.string(),
                    entryId: z.string(),
                    scope: PresetScope,
                    configPath: z.string(),
                    modelsSynced: z.boolean().optional(),
                    syncError: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          providerID: z.string().trim().min(1),
          scope: PresetScope,
          providerName: z.string().trim().min(1).optional(),
          providerNpm: z.string().trim().min(1).optional(),
          entry: z.object({
            entryId: z.string().trim().min(1),
            label: z.string().trim().min(1).optional(),
            baseURL: BaseUrlSchema,
            enabled: z.boolean().optional(),
            weight: z.number().positive().optional(),
          }),
          providerOptions: z
            .object({
              useChatCompletions: z.boolean().optional(),
            })
            .optional(),
          pool: z
            .object({
              policy: PoolPolicy.optional(),
              affinity: PoolAffinity.optional(),
              maxFailoverAttempts: z.number().int().min(0).optional(),
            })
            .optional(),
          syncModels: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { providerID, scope, entry, pool, providerOptions, providerName, providerNpm, syncModels } =
          c.req.valid("json")

        const projectRoot = Instance.project.vcs === "git" ? Instance.worktree : Instance.directory
        const baseDir = scope === "global" ? Global.Path.config : projectRoot
        const configPath = await resolveConfigPath(baseDir, { includeDotOpencode: scope === "project" })

        const file = Bun.file(configPath)
        const text = (await file.exists()) ? await file.text() : "{}"
        const parseErrors: JsoncParseError[] = []
        const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true }) as any
        if (parseErrors.length) {
          return c.json({ error: `Invalid JSONC in config file: ${configPath}` }, 400)
        }

        const existingEntriesRaw = parsed?.provider?.[providerID]?.pool?.entries
        const existingEntries = Array.isArray(existingEntriesRaw) ? (existingEntriesRaw as any[]) : []

        const nextEntry: Record<string, unknown> = {
          entryId: entry.entryId,
          baseURL: entry.baseURL,
        }
        if (entry.label !== undefined) nextEntry.label = entry.label
        if (entry.enabled !== undefined) nextEntry.enabled = entry.enabled
        if (entry.weight !== undefined) nextEntry.weight = entry.weight

        const nextEntries = existingEntries.map((item) => {
          if (item?.entryId !== entry.entryId) return item
          const merged = { ...(item ?? {}), ...nextEntry }
          delete (merged as any).apiKey
          return merged
        })
        if (!existingEntries.some((item) => item?.entryId === entry.entryId)) {
          nextEntries.push(nextEntry)
        }

        let modelsSynced = false
        let syncError: string | undefined

        const edits: ConfigEdit[] = []
        if (providerName) edits.push({ path: ["provider", providerID, "name"], value: providerName })
        if (providerNpm) edits.push({ path: ["provider", providerID, "npm"], value: providerNpm })
        edits.push({ path: ["provider", providerID, "pool", "entries"], value: nextEntries })
        if (providerOptions?.useChatCompletions !== undefined) {
          edits.push({
            path: ["provider", providerID, "options", "useChatCompletions"],
            value: providerOptions.useChatCompletions,
          })
        }
        if (pool?.policy !== undefined) {
          edits.push({ path: ["provider", providerID, "pool", "policy"], value: pool.policy })
        }
        if (pool?.affinity !== undefined) {
          edits.push({ path: ["provider", providerID, "pool", "affinity"], value: pool.affinity })
        }
        if (pool?.maxFailoverAttempts !== undefined) {
          edits.push({
            path: ["provider", providerID, "pool", "maxFailoverAttempts"],
            value: pool.maxFailoverAttempts,
          })
        }

        if (syncModels) {
          const apiKey = await Auth.Pool.get(providerID, entry.entryId)
          if (!apiKey) {
            syncError = "Model sync failed: API key not found for pool entry"
          } else {
            const discovered = await discoverOpenAICompatibleModels({ baseURL: entry.baseURL, apiKey })
            if (discovered.ok) {
              modelsSynced = true
              edits.push({ path: ["provider", providerID, "whitelist"], value: discovered.modelIDs })
            } else {
              syncError = `Model sync failed: ${discovered.error}`
            }
          }
        }

        try {
          await updateConfigFile(configPath, edits, { ensureSchema: true })
        } catch (error) {
          if (error instanceof ConfigFileEditError) {
            return c.json({ error: `${error.message}: ${error.path}` }, 400)
          }
          return c.json({ error: "Failed to update config file" }, 400)
        }

        return c.json({
          ok: true,
          providerID,
          entryId: entry.entryId,
          scope,
          configPath,
          ...(syncModels ? { modelsSynced, syncError } : {}),
        })
      },
    )
    .post(
      "/provider-key-pools/entries/remove",
      describeRoute({
        summary: "Remove provider key pool entry",
        description: "Remove a provider key pool entry from config. Does not remove secrets from the auth store.",
        operationId: "config.providerKeyPools.entries.remove",
        responses: {
          200: {
            description: "Entry removed",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    providerID: z.string(),
                    entryId: z.string(),
                    scope: PresetScope,
                    configPath: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          providerID: z.string().trim().min(1),
          scope: PresetScope,
          entryId: z.string().trim().min(1),
        }),
      ),
      async (c) => {
        const { providerID, scope, entryId } = c.req.valid("json")

        const projectRoot = Instance.project.vcs === "git" ? Instance.worktree : Instance.directory
        const baseDir = scope === "global" ? Global.Path.config : projectRoot
        const configPath = await resolveConfigPath(baseDir, { includeDotOpencode: scope === "project" })

        const file = Bun.file(configPath)
        const text = (await file.exists()) ? await file.text() : "{}"
        const parseErrors: JsoncParseError[] = []
        const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true }) as any
        if (parseErrors.length) {
          return c.json({ error: `Invalid JSONC in config file: ${configPath}` }, 400)
        }

        const existingEntriesRaw = parsed?.provider?.[providerID]?.pool?.entries
        const existingEntries = Array.isArray(existingEntriesRaw) ? (existingEntriesRaw as any[]) : []
        const nextEntries = existingEntries.filter((item) => item?.entryId !== entryId)

        const edits: ConfigEdit[] = [
          {
            path: ["provider", providerID, "pool", "entries"],
            value: nextEntries,
          },
        ]

        try {
          await updateConfigFile(configPath, edits, { ensureSchema: true })
        } catch (error) {
          if (error instanceof ConfigFileEditError) {
            return c.json({ error: `${error.message}: ${error.path}` }, 400)
          }
          return c.json({ error: "Failed to update config file" }, 400)
        }

        return c.json({ ok: true, providerID, entryId, scope, configPath })
      },
    ),
)
