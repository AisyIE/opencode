import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { type ParseError as JsoncParseError, parse as parseJsonc } from "jsonc-parser"

function createModelsServer(modelIDs: string[]) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ data: modelIDs.map((id) => ({ id })) })
      }
      return new Response("Not Found", { status: 404 })
    },
  })
}

test(
  "model sync writes provider whitelist during preset apply",
  async () => {
    const modelsServer = createModelsServer(["gpt-4o-mini"])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.jsonc"),
            `{
  // existing config
  "provider": {
    "openai": {
      "options": {
        "timeout": 123
      }
    }
  }
}
`,
          )
        },
      })

      const app = Server.App()
      const baseURL = `http://127.0.0.1:${modelsServer.port}/v1`
      const response = await app.request(`/config/provider-presets/apply?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset: "openai-classic",
          scope: "project",
          baseURL,
          apiKey: "secret-key",
          targetProviderID: "rightcode",
          targetProviderName: "RightCode",
          syncModels: true,
        }),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.providerID).toBe("rightcode")
      expect(body.modelsSynced).toBe(true)
      expect(body.syncError).toBeUndefined()

      const updated = await Bun.file(path.join(tmp.path, "opencode.jsonc")).text()
      const errors: JsoncParseError[] = []
      const parsed = parseJsonc(updated, errors, { allowTrailingComma: true }) as any
      expect(errors.length).toBe(0)
      expect(parsed.provider.rightcode.whitelist).toEqual(["gpt-4o-mini"])
    } finally {
      modelsServer.stop()
    }
  },
  { timeout: 20000 },
)

test(
  "whitelist filters provider model list after sync",
  async () => {
    const modelsServer = createModelsServer(["gpt-4o-mini"])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              // Ensure this test is not affected by global enabled/disabled provider filters.
              enabled_providers: ["rightcode"],
              provider: {
                rightcode: {
                  name: "RightCode",
                  npm: "@ai-sdk/openai",
                  api: "https://api.openai.com/v1",
                  // Provide a minimal models map so this test does not depend on models.dev freshness.
                  models: {
                    "gpt-4o-mini": {},
                    "gpt-5-nano": {},
                  },
                },
              },
            }),
          )
        },
      })

      const app = Server.App()
      const baseURL = `http://127.0.0.1:${modelsServer.port}/v1`
      const apply = await app.request(`/config/provider-presets/apply?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset: "openai-responses",
          scope: "project",
          baseURL,
          apiKey: "secret-key",
          targetProviderID: "rightcode",
          targetProviderName: "RightCode",
          syncModels: true,
        }),
      })
      expect(apply.status).toBe(200)

      const disposed = await app.request(`/instance/dispose?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
      })
      expect(disposed.status).toBe(200)

      const providers = await app.request(`/config/providers?directory=${encodeURIComponent(tmp.path)}`)
      expect(providers.status).toBe(200)
      const payload = await providers.json()
      const rightcode = payload.providers.find((p: any) => p.id === "rightcode")
      expect(rightcode).toBeTruthy()
      const ids = Object.keys(rightcode.models ?? {})
      expect(ids).toContain("gpt-4o-mini")
      expect(ids).not.toContain("gpt-5-nano")
    } finally {
      modelsServer.stop()
    }
  },
  { timeout: 20000 },
)
