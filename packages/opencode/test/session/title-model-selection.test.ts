import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { streamTitleWithFallback } from "../../src/session/title"

test("small model selection avoids gpt-5-nano when alternatives exist", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            rightcode: {
              name: "RightCode",
              npm: "@ai-sdk/openai",
              api: "https://proxy.example.com/v1",
              models: {
                "gpt-5-nano": {},
                "gpt-4o-mini": {},
              },
            },
          },
        }),
      )
    },
  })

  const model = await Instance.provide({
    directory: tmp.path,
    fn: async () => Provider.getSmallModel("rightcode"),
  })

  expect(model).toBeTruthy()
  expect(model!.id).toBe("gpt-4o-mini")
})

test("title generation falls back to primary model on model-not-found", async () => {
  const calls: string[] = []

  const stubStream = async (input: any) => {
    calls.push(`${input.model.providerID}/${input.model.id}`)
    if (input.model.id === "gpt-5-nano") {
      return { text: Promise.reject(new Error("model_not_found")) }
    }
    return { text: Promise.resolve("Hello title") }
  }

  const preferredModel = { providerID: "openai", id: "gpt-5-nano" } as any
  const primaryModel = { providerID: "openai", id: "gpt-4o-mini" } as any

  const result = await streamTitleWithFallback({
    preferredModel,
    primaryModel,
    sessionID: "sess",
    agent: { name: "title" } as any,
    user: { id: "user" } as any,
    messages: [{ role: "user", content: "Generate a title" }] as any,
    stream: stubStream as any,
    small: true,
    tools: {},
    system: [],
  })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.text).toBe("Hello title")
  expect(result.retried).toBe(true)
  expect(result.usedModel.id).toBe("gpt-4o-mini")
  expect(calls).toEqual(["openai/gpt-5-nano", "openai/gpt-4o-mini"])
})

