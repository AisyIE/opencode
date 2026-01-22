import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { createMemo, Match, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { base64Decode } from "@opencode-ai/util/encode"
import { useParams } from "@solidjs/router"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { DialogSelectProvider } from "./dialog-select-provider"

type PresetId = "openai-responses" | "openai-classic" | "anthropic" | "gemini"
type ScopeId = "global" | "project"

type Preset = {
  id: PresetId
  label: string
  providerID: string
  npm: string
  defaultBaseURL: string
  description: string
}

const PRESETS: Preset[] = [
  {
    id: "openai-responses",
    label: "OpenAI (Responses API)",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    defaultBaseURL: "https://api.openai.com/v1",
    description: "Best for official OpenAI Responses API and compatible proxies.",
  },
  {
    id: "openai-classic",
    label: "OpenAI (Classic API)",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    defaultBaseURL: "https://api.openai.com/v1",
    description: "Use chat completions for OpenAI-compatible proxies.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    providerID: "anthropic",
    npm: "@ai-sdk/anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    description: "Anthropic API or Anthropic-compatible proxies.",
  },
  {
    id: "gemini",
    label: "Gemini",
    providerID: "google",
    npm: "@ai-sdk/google",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    description: "Google Gemini API or compatible proxies.",
  },
]

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

function suggestPoolEntry(baseURL: string) {
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

function suggestProviderIdentity(baseURL: string) {
  try {
    const parsed = new URL(baseURL)
    const host = parsed.hostname
    const slug = host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
    return {
      providerId: slug ? slug : "provider",
      providerName: host,
    }
  } catch {
    return { providerId: "provider", providerName: "" }
  }
}

export function DialogConnectProviderPreset() {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const params = useParams()
  const currentDirectory = createMemo(() => base64Decode(params.dir ?? ""))
  const hasProject = createMemo(() => !!currentDirectory())

  const [store, setStore] = createStore({
    step: "scope" as "scope" | "preset" | "form",
    scope: undefined as ScopeId | undefined,
    preset: undefined as PresetId | undefined,
    baseURL: "",
    apiKey: "",
    createProvider: false,
    providerName: "",
    providerId: "",
    syncModels: true,
    usePool: false,
    entryId: "",
    poolPolicy: "metered" as "metered" | "quota",
    submitting: false,
    error: undefined as string | undefined,
    baseUrlError: undefined as string | undefined,
    apiKeyError: undefined as string | undefined,
    providerNameError: undefined as string | undefined,
    providerIdError: undefined as string | undefined,
    entryIdError: undefined as string | undefined,
  })

  const selectedPreset = createMemo(() => PRESETS.find((preset) => preset.id === store.preset))

  const poolPolicyOptions: Array<{ value: "metered" | "quota"; label: string }> = [
    { value: "metered", label: "Metered (sticky)" },
    { value: "quota", label: "Quota (balanced)" },
  ]

  onMount(() => {
    if (!hasProject()) {
      setStore(
        produce((draft) => {
          draft.scope = "global"
          draft.step = "preset"
        }),
      )
    }
  })

  const scopeOptions = createMemo(() => {
    if (!hasProject()) return [{ id: "global", label: "Global", hint: "Applies to all projects" }]
    return [
      {
        id: "project",
        label: "Current project",
        hint: "Only this project",
      },
      {
        id: "global",
        label: "Global",
        hint: "Applies to all projects",
      },
    ]
  })

  function goBack() {
    if (store.step === "form") {
      setStore("step", "preset")
      return
    }
    if (store.step === "preset") {
      if (hasProject()) {
        setStore("step", "scope")
        return
      }
    }
    dialog.show(() => <DialogSelectProvider />)
  }

  async function applyPreset() {
    const preset = selectedPreset()
    if (!preset || !store.scope) return

    const baseURL = store.baseURL.trim()
    const apiKey = store.apiKey.trim()
    const providerId = store.createProvider ? store.providerId.trim() : undefined
    const providerName = store.createProvider ? store.providerName.trim() : undefined

    const baseUrlError = !baseURL ? "Base URL is required" : isValidBaseUrl(baseURL) ? undefined : "Invalid Base URL"
    const apiKeyError = !apiKey ? "API key is required" : undefined
    const providerNameError = store.createProvider && !providerName ? "Provider name is required" : undefined
    const providerIdError =
      store.createProvider && !providerId
        ? "Provider ID is required"
        : store.createProvider && providerId && !isValidProviderId(providerId)
          ? "Provider ID must be a lowercase slug (a-z, 0-9, -, _)"
          : undefined
    const entryIdError = store.usePool && !store.entryId.trim() ? "Entry ID is required" : undefined

    setStore({
      baseUrlError,
      apiKeyError,
      providerNameError,
      providerIdError,
      entryIdError,
      error: undefined,
    })

    if (baseUrlError || apiKeyError || providerNameError || providerIdError || entryIdError) return

    setStore("submitting", true)
    try {
      const scopedClient =
        store.scope === "project" && currentDirectory()
          ? createOpencodeClient({
              baseUrl: globalSDK.url,
              fetch: platform.fetch,
              directory: currentDirectory(),
              throwOnError: true,
            })
          : globalSDK.client

      if (!store.usePool) {
        const res = await scopedClient.config.providerPresets.apply({
          preset: preset.id,
          scope: store.scope,
          baseURL,
          apiKey,
          syncModels: store.syncModels,
          ...(providerId ? { targetProviderID: providerId, targetProviderName: providerName ?? providerId } : {}),
        })
        if (res.data?.syncError) {
          showToast({
            variant: "error",
            title: "Model sync failed",
            description: res.data.syncError,
          })
        }
      } else {
        const suggested = suggestPoolEntry(baseURL)
        const targetProviderID = providerId ?? preset.providerID
        await scopedClient.auth.pool.set({
          providerID: targetProviderID,
          entryId: store.entryId.trim(),
          key: apiKey,
        })

        try {
          const res = await scopedClient.config.providerKeyPools.entries.apply({
            providerID: targetProviderID,
            scope: store.scope,
            ...(store.createProvider ? { providerName: providerName ?? targetProviderID, providerNpm: preset.npm } : {}),
            entry: {
              entryId: store.entryId.trim(),
              label: suggested.label,
              baseURL,
            },
            providerOptions:
              preset.id === "openai-responses" || preset.id === "openai-classic"
                ? { useChatCompletions: preset.id === "openai-classic" }
                : undefined,
            pool: { policy: store.poolPolicy },
            syncModels: store.syncModels,
          })
          if (res.data?.syncError) {
            showToast({
              variant: "error",
              title: "Model sync failed",
              description: res.data.syncError,
            })
          }
        } catch (error) {
          await scopedClient.auth.pool.remove({ providerID: targetProviderID, entryId: store.entryId.trim() }).catch(
            () => {},
          )
          throw error
        }
      }

      await globalSDK.client.global.dispose()
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: store.usePool ? "Key pool entry added" : "Provider preset applied",
        description: store.usePool ? `${preset.label} pool entry is now configured.` : `${preset.label} is now configured.`,
      })
    } catch (error) {
      setStore("error", String(error))
    } finally {
      setStore("submitting", false)
    }
  }

  return (
    <Dialog title={<IconButton tabIndex={-1} icon="arrow-left" variant="ghost" onClick={goBack} />}>
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <Show when={selectedPreset()} fallback={<Icon name="plus-small" class="size-5 text-icon-weak" />}>
            <ProviderIcon id={selectedPreset()!.providerID as IconName} class="size-5 shrink-0 icon-strong-base" />
          </Show>
          <div class="text-16-medium text-text-strong">Connect with a preset</div>
        </div>
        <div class="px-2.5 pb-6 flex flex-col gap-6">
          <Switch>
            <Match when={store.step === "scope"}>
              <div class="text-14-regular text-text-base">Select where to save this configuration.</div>
              <List
                key={(item) => item.id}
                items={scopeOptions()}
                onSelect={(item) => {
                  if (!item) return
                  setStore(
                    produce((draft) => {
                      draft.scope = item.id as ScopeId
                      draft.step = "preset"
                    }),
                  )
                }}
              >
                {(item) => (
                  <div class="w-full flex items-center justify-between gap-x-2">
                    <span>{item.label}</span>
                    <span class="text-12-regular text-text-weak">{item.hint}</span>
                  </div>
                )}
              </List>
            </Match>
            <Match when={store.step === "preset"}>
              <div class="text-14-regular text-text-base">Choose a provider preset.</div>
              <List
                search={{ placeholder: "Search presets", autofocus: true }}
                key={(item) => item.id}
                items={PRESETS}
                filterKeys={["label", "providerID"]}
                onSelect={(item) => {
                  if (!item) return
                  const suggestedProvider = suggestProviderIdentity(item.defaultBaseURL)
                  setStore(
                    produce((draft) => {
                      draft.preset = item.id
                      draft.baseURL = item.defaultBaseURL
                      draft.apiKey = ""
                      draft.createProvider = false
                      draft.providerName = suggestedProvider.providerName
                      draft.providerId = suggestedProvider.providerId
                      draft.syncModels = true
                      draft.usePool = false
                      draft.entryId = suggestPoolEntry(item.defaultBaseURL).entryId
                      draft.poolPolicy = "metered"
                      draft.baseUrlError = undefined
                      draft.apiKeyError = undefined
                      draft.providerNameError = undefined
                      draft.providerIdError = undefined
                      draft.entryIdError = undefined
                      draft.step = "form"
                    }),
                  )
                }}
              >
                {(item) => (
                  <div class="w-full flex flex-col gap-1">
                    <div class="flex items-center gap-2">
                      <ProviderIcon id={item.providerID as IconName} class="size-4 shrink-0 icon-weak-base" />
                      <span>{item.label}</span>
                    </div>
                    <span class="text-12-regular text-text-weak">{item.description}</span>
                  </div>
                )}
              </List>
            </Match>
            <Match when={store.step === "form"}>
              <Show when={selectedPreset()}>
                <div class="flex flex-col gap-4">
                  <div class="text-14-regular text-text-base">
                    Enter the Base URL and API key for {selectedPreset()!.label}.
                  </div>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      void applyPreset()
                    }}
                    class="flex flex-col items-start gap-4"
                  >
                    <TextField
                      autofocus
                      type="text"
                      label="Base URL"
                      placeholder="https://api.example.com/v1"
                      name="baseURL"
                      value={store.baseURL}
                      onChange={setStore.bind(null, "baseURL")}
                      validationState={store.baseUrlError ? "invalid" : undefined}
                      error={store.baseUrlError}
                    />
                    <TextField
                      type="text"
                      label="API key"
                      placeholder="API key"
                      name="apiKey"
                      value={store.apiKey}
                      onChange={setStore.bind(null, "apiKey")}
                      validationState={store.apiKeyError ? "invalid" : undefined}
                      error={store.apiKeyError}
                    />
                    <div class="w-full flex items-center justify-between gap-3">
                      <div class="flex flex-col">
                        <span class="text-12-regular text-text-base">Sync models from endpoint</span>
                        <span class="text-12-regular text-text-weak">Fetch /models and store a provider whitelist (best-effort).</span>
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Toggle checked={store.syncModels} onChange={(checked) => setStore("syncModels", checked)} />
                      </div>
                    </div>
                    <div class="w-full flex items-center justify-between gap-3">
                      <div class="flex flex-col">
                        <span class="text-12-regular text-text-base">Create new provider</span>
                        <span class="text-12-regular text-text-weak">Use a custom provider ID so proxies don’t replace built-ins.</span>
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Toggle checked={store.createProvider} onChange={(checked) => setStore("createProvider", checked)} />
                      </div>
                    </div>
                    <Show when={store.createProvider}>
                      <TextField
                        type="text"
                        label="Provider name"
                        placeholder="RightCode"
                        name="providerName"
                        value={store.providerName}
                        onChange={setStore.bind(null, "providerName")}
                        validationState={store.providerNameError ? "invalid" : undefined}
                        error={store.providerNameError}
                      />
                      <TextField
                        type="text"
                        label="Provider ID"
                        placeholder="rightcode"
                        name="providerId"
                        value={store.providerId}
                        onChange={setStore.bind(null, "providerId")}
                        validationState={store.providerIdError ? "invalid" : undefined}
                        error={store.providerIdError}
                      />
                    </Show>
                    <div class="w-full flex items-center justify-between gap-3">
                      <div class="flex flex-col">
                        <span class="text-12-regular text-text-base">Add to key pool</span>
                        <span class="text-12-regular text-text-weak">Store multiple Base URLs and API keys per provider.</span>
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Toggle checked={store.usePool} onChange={(checked) => setStore("usePool", checked)} />
                      </div>
                    </div>
                    <Show when={store.usePool}>
                      <div class="w-full flex items-center justify-between gap-3">
                        <div class="flex flex-col">
                          <span class="text-12-regular text-text-base">Rotation policy</span>
                          <span class="text-12-regular text-text-weak">Control how requests are distributed across entries.</span>
                        </div>
                        <Select
                          options={poolPolicyOptions}
                          current={poolPolicyOptions.find((o) => o.value === store.poolPolicy)}
                          value={(o) => o.value}
                          label={(o) => o.label}
                          onSelect={(option) => option && setStore("poolPolicy", option.value)}
                          variant="secondary"
                          size="small"
                        />
                      </div>
                      <TextField
                        type="text"
                        label="Entry ID"
                        placeholder="proxy-a"
                        name="entryId"
                        value={store.entryId}
                        onChange={setStore.bind(null, "entryId")}
                        validationState={store.entryIdError ? "invalid" : undefined}
                        error={store.entryIdError}
                      />
                    </Show>
                    <Show when={store.error}>
                      <div class="text-12-regular text-text-critical">{store.error}</div>
                    </Show>
                    <Button class="w-auto" type="submit" size="large" variant="primary" disabled={store.submitting}>
                      {store.submitting ? "Applying..." : "Apply preset"}
                    </Button>
                  </form>
                </div>
              </Show>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  )
}
