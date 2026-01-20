import { expect, mock, test } from "bun:test"
import path from "path"

mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string, _version?: string) => {
      const lastAtIndex = pkg.lastIndexOf("@")
      return lastAtIndex > 0 ? pkg.substring(0, lastAtIndex) : pkg
    },
    run: async () => {
      throw new Error("BunProc.run should not be called in tests")
    },
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))

const mockPlugin = () => ({})
mock.module("opencode-copilot-auth", () => ({ default: mockPlugin }))
mock.module("opencode-anthropic-auth", () => ({ default: mockPlugin }))
mock.module("@gitlab/opencode-gitlab-auth", () => ({ default: mockPlugin }))

const modelsDevData = {
  openai: {
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-4.1": {
        id: "gpt-4.1",
        name: "GPT-4.1",
        release_date: "2024-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 8192, output: 2048 },
        options: {},
      },
    },
  },
}

const { tmpdir } = await import("../fixture/fixture")
const { Instance } = await import("../../src/project/instance")
const { Env } = await import("../../src/env")
const { ModelsDev } = await import("../../src/provider/models")

;(ModelsDev as any).get = async () => modelsDevData

const { Provider } = await import("../../src/provider/provider")

test(
  "openai uses chat completions when useChatCompletions is true",
  async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              options: {
                apiKey: "test-key",
                useChatCompletions: true,
              },
            },
          },
        }),
      )
    },
  })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENAI_API_KEY", "test-key")
        const providers = await Provider.list()
        const openai = providers["openai"]
        const modelID = Object.keys(openai.models)[0]
        const model = await Provider.getModel("openai", modelID)
        const language = await Provider.getLanguage(model)
        expect((language as any).provider).toBe("openai.chat")
      },
    })
  },
  { timeout: 10000 },
)

test(
  "openai defaults to responses when useChatCompletions is false",
  async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              options: {
                apiKey: "test-key",
                useChatCompletions: false,
              },
            },
          },
        }),
      )
    },
  })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENAI_API_KEY", "test-key")
        const providers = await Provider.list()
        const openai = providers["openai"]
        const modelID = Object.keys(openai.models)[0]
        const model = await Provider.getModel("openai", modelID)
        const language = await Provider.getLanguage(model)
        expect((language as any).provider).toBe("openai.responses")
      },
    })
  },
  { timeout: 10000 },
)
