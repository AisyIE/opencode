import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  const filepath = path.join(Global.Path.data, "auth.json")
  const poolFilepath = path.join(Global.Path.data, "auth-pool.json")

  const PoolStore = z.record(z.string(), z.record(z.string(), z.object({ key: z.string() }).strict())).meta({
    ref: "AuthPoolStore",
  })
  type PoolStore = z.infer<typeof PoolStore>

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const file = Bun.file(filepath)
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    const file = Bun.file(filepath)
    const data = await all()
    await Bun.write(file, JSON.stringify({ ...data, [key]: info }, null, 2))
    await fs.chmod(file.name!, 0o600)
  }

  export async function remove(key: string) {
    const file = Bun.file(filepath)
    const data = await all()
    delete data[key]
    await Bun.write(file, JSON.stringify(data, null, 2))
    await fs.chmod(file.name!, 0o600)
  }

  export namespace Pool {
    export async function all(): Promise<PoolStore> {
      const file = Bun.file(poolFilepath)
      const data = await file.json().catch(() => ({}) as Record<string, unknown>)
      const parsed = PoolStore.safeParse(data)
      return parsed.success ? parsed.data : {}
    }

    export async function get(providerID: string, entryId: string): Promise<string | undefined> {
      const data = await all()
      return data[providerID]?.[entryId]?.key
    }

    export async function set(providerID: string, entryId: string, key: string) {
      const file = Bun.file(poolFilepath)
      const data = await all()
      const provider = data[providerID] ?? {}
      provider[entryId] = { key }
      await Bun.write(file, JSON.stringify({ ...data, [providerID]: provider }, null, 2))
      await fs.chmod(file.name!, 0o600)
    }

    export async function remove(providerID: string, entryId: string) {
      const file = Bun.file(poolFilepath)
      const data = await all()
      if (!data[providerID]) return
      delete data[providerID][entryId]
      if (Object.keys(data[providerID]).length === 0) {
        delete data[providerID]
      }
      await Bun.write(file, JSON.stringify(data, null, 2))
      await fs.chmod(file.name!, 0o600)
    }
  }
}
