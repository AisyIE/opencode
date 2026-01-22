import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { type ParseError as JsoncParseError, parse as parseJsonc } from "jsonc-parser"

test("apply preset updates project config without apiKey", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.jsonc"),
        `{
  // existing config
  "provider": {
    "anthropic": {
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
  const response = await app.request(`/config/provider-presets/apply?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preset: "openai-classic",
      scope: "project",
      baseURL: "https://proxy.example.com/v1",
      apiKey: "secret-key",
    }),
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.providerID).toBe("openai")
  expect(body.scope).toBe("project")
  expect(body.configPath).toBe(path.join(tmp.path, "opencode.jsonc"))

  const updated = await Bun.file(path.join(tmp.path, "opencode.jsonc")).text()
  expect(updated).toContain("// existing config")
  expect(updated).toContain('"baseURL": "https://proxy.example.com/v1"')
  expect(updated).toContain('"useChatCompletions": true')
  expect(updated).toContain('"timeout": 123')
  expect(updated).not.toContain("secret-key")
})

test("apply preset rejects invalid baseURL", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.json"), `{"provider":{}}`)
    },
  })

  const app = Server.App()
  const response = await app.request(`/config/provider-presets/apply?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preset: "anthropic",
      scope: "project",
      baseURL: "not-a-url",
      apiKey: "test-key",
    }),
  })

  expect(response.status).toBe(400)
  const updated = await Bun.file(path.join(tmp.path, "opencode.json")).text()
  expect(updated).not.toContain("baseURL")
  expect(updated).not.toContain("useChatCompletions")
})

test("apply preset can create a custom provider identity", async () => {
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
  const response = await app.request(`/config/provider-presets/apply?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preset: "openai-responses",
      scope: "project",
      baseURL: "https://proxy.example.com/v1",
      apiKey: "secret-key",
      targetProviderID: "rightcode",
      targetProviderName: "RightCode",
    }),
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.providerID).toBe("rightcode")

  const updated = await Bun.file(path.join(tmp.path, "opencode.jsonc")).text()
  expect(updated).toContain("// existing config")
  expect(updated).not.toContain("secret-key")

  const errors: JsoncParseError[] = []
  const parsed = parseJsonc(updated, errors, { allowTrailingComma: true }) as any
  expect(errors.length).toBe(0)
  expect(parsed.provider.rightcode.name).toBe("RightCode")
  expect(parsed.provider.rightcode.npm).toBe("@ai-sdk/openai")
  expect(parsed.provider.rightcode.options.baseURL).toBe("https://proxy.example.com/v1")
  expect(parsed.provider.rightcode.options.useChatCompletions).toBe(false)
  expect(parsed.provider.openai.options.baseURL).toBeUndefined()
})

test("apply preset rejects invalid targetProviderID", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.json"), `{"provider":{}}`)
    },
  })

  const app = Server.App()
  const response = await app.request(`/config/provider-presets/apply?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preset: "openai-classic",
      scope: "project",
      baseURL: "https://proxy.example.com/v1",
      apiKey: "test-key",
      targetProviderID: "openai/foo",
      targetProviderName: "Bad",
    }),
  })

  expect(response.status).toBe(400)
})
