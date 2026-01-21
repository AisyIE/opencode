import type { Tool } from "ai"
import type { ModelMessage } from "ai"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import type { Provider } from "@/provider/provider"

export type TitleStreamResult = { text: Promise<string> }
export type TitleStreamFn = (input: LLM.StreamInput) => Promise<TitleStreamResult>

function isModelNotFoundText(text: string) {
  const lower = text.toLowerCase()
  if (lower.includes("model_not_found")) return true
  if (lower.includes("model not found")) return true
  if (lower.includes("unknown model")) return true
  if (lower.includes("invalid model")) return true
  return lower.includes("model") && lower.includes("does not exist")
}

export function isModelNotFoundRuntimeError(error: unknown) {
  const visited = new Set<unknown>()
  const stack: unknown[] = [error]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)

    if (typeof current === "string") {
      if (isModelNotFoundText(current)) return true
      continue
    }

    if (current instanceof Error) {
      if (isModelNotFoundText(current.message)) return true
      // Bun / AI SDK errors often nest the raw body or cause
      const anyCurrent = current as any
      if (typeof anyCurrent.responseBody === "string" && isModelNotFoundText(anyCurrent.responseBody)) return true
      if (typeof anyCurrent.body === "string" && isModelNotFoundText(anyCurrent.body)) return true
      if (typeof anyCurrent.cause !== "undefined") stack.push(anyCurrent.cause)
      continue
    }

    if (typeof current === "object") {
      const anyCurrent = current as any
      if (typeof anyCurrent.message === "string" && isModelNotFoundText(anyCurrent.message)) return true
      for (const key of ["cause", "error", "responseBody", "body", "data"]) {
        if (typeof anyCurrent[key] !== "undefined") stack.push(anyCurrent[key])
      }
    }
  }

  return false
}

export async function streamTitleWithFallback(input: {
  preferredModel: Provider.Model
  primaryModel: Provider.Model
  sessionID: string
  agent: Agent.Info
  user: MessageV2.User
  messages: ModelMessage[]
  system?: string[]
  tools?: Record<string, Tool>
  abort?: AbortSignal
  retries?: number
  small?: boolean
  stream?: TitleStreamFn
}) {
  const streamFn = input.stream ?? (LLM.stream as unknown as TitleStreamFn)
  const abort = input.abort ?? new AbortController().signal
  const tools = input.tools ?? {}
  const system = input.system ?? []

  const attempt = async (model: Provider.Model) => {
    const result = await streamFn({
      agent: input.agent,
      user: input.user,
      system,
      tools,
      small: input.small,
      model,
      abort,
      sessionID: input.sessionID,
      retries: input.retries,
      messages: input.messages,
    })
    return result.text
  }

  try {
    const text = await attempt(input.preferredModel)
    return { ok: true as const, text, usedModel: input.preferredModel, retried: false }
  } catch (error) {
    const sameModel =
      input.preferredModel.providerID === input.primaryModel.providerID && input.preferredModel.id === input.primaryModel.id

    if (!sameModel && isModelNotFoundRuntimeError(error)) {
      try {
        const text = await attempt(input.primaryModel)
        return { ok: true as const, text, usedModel: input.primaryModel, retried: true }
      } catch (fallbackError) {
        return {
          ok: false as const,
          error: fallbackError,
          usedModel: input.primaryModel,
          retried: true,
        }
      }
    }

    return { ok: false as const, error, usedModel: input.preferredModel, retried: false }
  }
}

