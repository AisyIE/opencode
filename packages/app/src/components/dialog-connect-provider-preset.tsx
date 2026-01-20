import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
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
  defaultBaseURL: string
  description: string
}

const PRESETS: Preset[] = [
  {
    id: "openai-responses",
    label: "OpenAI (Responses API)",
    providerID: "openai",
    defaultBaseURL: "https://api.openai.com/v1",
    description: "Best for official OpenAI Responses API and compatible proxies.",
  },
  {
    id: "openai-classic",
    label: "OpenAI (Classic API)",
    providerID: "openai",
    defaultBaseURL: "https://api.openai.com/v1",
    description: "Use chat completions for OpenAI-compatible proxies.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    providerID: "anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    description: "Anthropic API or Anthropic-compatible proxies.",
  },
  {
    id: "gemini",
    label: "Gemini",
    providerID: "google",
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
    submitting: false,
    error: undefined as string | undefined,
    baseUrlError: undefined as string | undefined,
    apiKeyError: undefined as string | undefined,
  })

  const selectedPreset = createMemo(() => PRESETS.find((preset) => preset.id === store.preset))

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

    const baseUrlError = !baseURL ? "Base URL is required" : isValidBaseUrl(baseURL) ? undefined : "Invalid Base URL"
    const apiKeyError = !apiKey ? "API key is required" : undefined

    setStore({
      baseUrlError,
      apiKeyError,
      error: undefined,
    })

    if (baseUrlError || apiKeyError) return

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

      await scopedClient.config.providerPresets.apply({
        preset: preset.id,
        scope: store.scope,
        baseURL,
        apiKey,
      })

      await globalSDK.client.global.dispose()
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: "Provider preset applied",
        description: `${preset.label} is now configured.`,
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
                  setStore(
                    produce((draft) => {
                      draft.preset = item.id
                      draft.baseURL = item.defaultBaseURL
                      draft.apiKey = ""
                      draft.baseUrlError = undefined
                      draft.apiKeyError = undefined
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
