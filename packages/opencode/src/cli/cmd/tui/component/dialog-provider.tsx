import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  anthropic: 1,
  "github-copilot": 2,
  openai: 3,
  google: 4,
}

type PresetId = "openai-responses" | "openai-classic" | "anthropic" | "gemini"
type PresetScope = "global" | "project"
type PoolPolicy = "metered" | "quota"
type PresetSaveMode = "single" | "pool"

type ProviderPreset = {
  id: PresetId
  title: string
  providerID: string
  npm: string
  defaultBaseURL: string
  description: string
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai-responses",
    title: "OpenAI (Responses API)",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    defaultBaseURL: "https://api.openai.com/v1",
    description: "Use OpenAI Responses API with official or compatible endpoints.",
  },
  {
    id: "openai-classic",
    title: "OpenAI (Classic API)",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    defaultBaseURL: "https://api.openai.com/v1",
    description: "Use chat completions for OpenAI-compatible proxies.",
  },
  {
    id: "anthropic",
    title: "Anthropic",
    providerID: "anthropic",
    npm: "@ai-sdk/anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    description: "Anthropic API or compatible proxies.",
  },
  {
    id: "gemini",
    title: "Gemini",
    providerID: "google",
    npm: "@ai-sdk/google",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    description: "Google Gemini API or compatible proxies.",
  },
]

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const connected = createMemo(() => new Set(sync.data.provider_next.connected))

  const selectOption = async <T,>(title: string, options: { title: string; value: T; description?: string }[]) => {
    return new Promise<T | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title={title}
            options={options.map((option) => ({
              title: option.title,
              value: option.value,
              description: option.description,
            }))}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(null),
      )
    })
  }

  const promptValue = async (title: string, value?: string, placeholder?: string) => {
    return DialogPrompt.show(dialog, title, { value, placeholder })
  }

  const isValidBaseUrl = (value: string) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      return false
    }
  }

  const isValidProviderId = (value: string) => {
    if (!value) return false
    if (value.includes("/")) return false
    return /^[a-z][a-z0-9-_]*$/.test(value) && value.length <= 50
  }

  const suggestPoolEntry = (baseURL: string) => {
    try {
      const parsed = new URL(baseURL)
      const host = parsed.hostname
      const slug = host
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
      const suffix = Math.random().toString(36).slice(2, 6)
      return {
        entryId: slug ? `${slug}-${suffix}` : `entry-${suffix}`,
        label: host,
      }
    } catch {
      const suffix = Math.random().toString(36).slice(2, 6)
      return { entryId: `entry-${suffix}` }
    }
  }

  const suggestProviderIdentity = (baseURL: string) => {
    try {
      const parsed = new URL(baseURL)
      const host = parsed.hostname
      const slug = host
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
      return { providerId: slug ? slug : "provider", providerName: host }
    } catch {
      return { providerId: "provider", providerName: "" }
    }
  }

  const runPresetFlow = async () => {
    const scope = await selectOption<PresetScope>("Location", [
      { title: "Current project", value: "project", description: "Save to project opencode.json" },
      { title: "Global", value: "global", description: "Save to global opencode.json" },
    ])
    if (!scope) {
      dialog.replace(() => <DialogProvider />)
      return
    }

    const preset = await selectOption<ProviderPreset>(
      "Select preset",
      PROVIDER_PRESETS.map((item) => ({
        title: item.title,
        value: item,
        description: item.description,
      })),
    )
    if (!preset) {
      dialog.replace(() => <DialogProvider />)
      return
    }

    const baseURL = await promptValue("Base URL", preset.defaultBaseURL, "https://api.example.com/v1")
    if (!baseURL) {
      dialog.replace(() => <DialogProvider />)
      return
    }
    if (!isValidBaseUrl(baseURL.trim())) {
      toast.show({ message: "Invalid Base URL", variant: "error" })
      dialog.replace(() => <DialogProvider />)
      return
    }

    const apiKey = await promptValue("API key", undefined, "Enter API key")
    if (!apiKey?.trim()) {
      toast.show({ message: "API key is required", variant: "error" })
      dialog.replace(() => <DialogProvider />)
      return
    }

    try {
      const syncModels = await selectOption<boolean>("Sync models from endpoint", [
        { title: "Yes", value: true, description: "Fetch /models and store a provider whitelist (best-effort)." },
        { title: "No", value: false, description: "Skip model sync." },
      ])
      if (syncModels == null) {
        dialog.replace(() => <DialogProvider />)
        return
      }

      const targetMode = await selectOption<"builtin" | "custom">("Target provider", [
        { title: "Use built-in provider", value: "builtin", description: "Apply preset to the built-in provider slot." },
        { title: "Create new provider", value: "custom", description: "Create a named provider for proxies/relays." },
      ])
      if (!targetMode) {
        dialog.replace(() => <DialogProvider />)
        return
      }

      let targetProviderID = preset.providerID
      let targetProviderName: string | undefined
      let targetProviderNpm: string | undefined

      if (targetMode === "custom") {
        const suggestedProvider = suggestProviderIdentity(baseURL.trim())
        const name = await promptValue("Provider name", suggestedProvider.providerName || preset.title, "RightCode")
        if (!name?.trim()) {
          toast.show({ message: "Provider name is required", variant: "error" })
          dialog.replace(() => <DialogProvider />)
          return
        }
        const id = await promptValue("Provider ID", suggestedProvider.providerId, "rightcode")
        if (!id?.trim() || !isValidProviderId(id.trim())) {
          toast.show({ message: "Invalid Provider ID (use lowercase slug)", variant: "error" })
          dialog.replace(() => <DialogProvider />)
          return
        }
        targetProviderID = id.trim()
        targetProviderName = name.trim()
        targetProviderNpm = preset.npm
      }

      const saveMode = await selectOption<PresetSaveMode>("Save mode", [
        {
          title: "Single provider config",
          value: "single",
          description: "Overwrite base URL and store one API key.",
        },
        {
          title: "Key pool entry",
          value: "pool",
          description: "Add this endpoint as a pool entry for rotation/failover.",
        },
      ])

      if (!saveMode) {
        dialog.replace(() => <DialogProvider />)
        return
      }

      if (saveMode === "single") {
        const res = await sdk.client.config.providerPresets.apply({
          preset: preset.id,
          scope,
          baseURL: baseURL.trim(),
          apiKey: apiKey.trim(),
          syncModels,
          ...(targetMode === "custom"
            ? { targetProviderID: targetProviderID, targetProviderName: targetProviderName ?? targetProviderID }
            : {}),
        })
        if (res.data?.syncError) toast.show({ message: res.data.syncError, variant: "error" })
      } else {
        const suggested = suggestPoolEntry(baseURL.trim())
        const entryId = await promptValue("Entry ID", suggested.entryId, "proxy-a")
        if (!entryId?.trim()) {
          dialog.replace(() => <DialogProvider />)
          return
        }

        const policy = await selectOption<PoolPolicy>("Rotation policy", [
          { title: "Metered (sticky)", value: "metered", description: "Prefer reusing one entry for cache reuse." },
          { title: "Quota (balanced)", value: "quota", description: "Distribute across entries for throughput." },
        ])
        if (!policy) {
          dialog.replace(() => <DialogProvider />)
          return
        }

        await sdk.client.auth.pool.set({
          providerID: targetProviderID,
          entryId: entryId.trim(),
          key: apiKey.trim(),
        })
        try {
          const res = await sdk.client.config.providerKeyPools.entries.apply({
            providerID: targetProviderID,
            scope,
            ...(targetMode === "custom"
              ? { providerName: targetProviderName ?? targetProviderID, providerNpm: targetProviderNpm }
              : {}),
            entry: {
              entryId: entryId.trim(),
              label: suggested.label,
              baseURL: baseURL.trim(),
            },
            providerOptions:
              preset.id === "openai-responses" || preset.id === "openai-classic"
                ? { useChatCompletions: preset.id === "openai-classic" }
                : undefined,
            pool: { policy },
            syncModels,
          })
          if (res.data?.syncError) toast.show({ message: res.data.syncError, variant: "error" })
        } catch (error) {
          await sdk.client.auth.pool.remove({ providerID: targetProviderID, entryId: entryId.trim() }).catch(() => {})
          throw error
        }
      }

      await sdk.client.instance.dispose()
      await sync.bootstrap()
      toast.show({ message: saveMode === "pool" ? "Key pool entry added" : "Preset applied", variant: "success" })
      dialog.replace(() => <DialogModel providerID={targetProviderID} />)
    } catch (error) {
      toast.error(error)
      dialog.replace(() => <DialogProvider />)
    }
  }

  const options = createMemo(() => {
    const providerOptions = pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const isConnected = connected().has(provider.id)
        return {
          title: provider.name,
          value: provider.id,
          description: {
            opencode: "(Recommended)",
            anthropic: "(Claude Max or API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
          }[provider.id],
          category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
          footer: isConnected ? "Connected" : undefined,
          async onSelect() {
            const methods = sync.data.provider_auth[provider.id] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              const result = await sdk.client.provider.oauth.authorize({
                providerID: provider.id,
                method: index,
              })
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
            }
            if (method.type === "api") {
              return dialog.replace(() => <ApiMethod providerID={provider.id} title={method.label} />)
            }
          },
        }
      }),
    )

    const presetOption = {
      title: "Other provider",
      value: "other",
      description: "(Use preset + base URL + API key)",
      category: "Other",
      async onSelect() {
        await runPresetFlow()
      },
    }

    const popularOptions = providerOptions.filter((option) => option.category === "Popular")
    const otherOptions = providerOptions.filter((option) => option.category !== "Popular")
    return [...popularOptions, presetOption, ...otherOptions]
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={
        props.providerID === "opencode" ? (
          <box gap={1}>
            <text fg={theme.textMuted}>
              OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single API key.
            </text>
            <text fg={theme.text}>
              Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
            </text>
          </box>
        ) : undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}
