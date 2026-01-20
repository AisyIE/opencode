import { Component, Show, createMemo } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { IconName } from "@opencode-ai/ui/icons/provider"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { DialogConnectProviderPreset } from "./dialog-connect-provider-preset"
import { Icon } from "@opencode-ai/ui/icon"

export const DialogSelectProvider: Component = () => {
  const dialog = useDialog()
  const providers = useProviders()
  const items = createMemo(() => [
    ...providers.all(),
    {
      id: "other",
      name: "Other provider",
    },
  ])

  return (
    <Dialog title="Connect provider">
      <List
        search={{ placeholder: "Search providers", autofocus: true }}
        activeIcon="plus-small"
        key={(x) => x?.id}
        items={items}
        filterKeys={["id", "name"]}
        groupBy={(x) => (popularProviders.includes(x.id) ? "Popular" : "Other")}
        sortBy={(a, b) => {
          if (a.id === "other") return -1
          if (b.id === "other") return 1
          if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
            return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
          return a.name.localeCompare(b.name)
        }}
        sortGroupsBy={(a, b) => {
          if (a.category === "Popular" && b.category !== "Popular") return -1
          if (b.category === "Popular" && a.category !== "Popular") return 1
          return 0
        }}
        onSelect={(x) => {
          if (!x) return
          if (x.id === "other") {
            dialog.show(() => <DialogConnectProviderPreset />)
            return
          }
          dialog.show(() => <DialogConnectProvider provider={x.id} />)
        }}
      >
        {(i) => (
          <div class="px-1.25 w-full flex items-center gap-x-3">
            <Show
              when={i.id !== "other"}
              fallback={<Icon name="plus-small" class="size-4 text-icon-weak" />}
            >
              <ProviderIcon data-slot="list-item-extra-icon" id={i.id as IconName} />
            </Show>
            <span>{i.name}</span>
            <Show when={i.id === "opencode"}>
              <Tag>Recommended</Tag>
            </Show>
            <Show when={i.id === "anthropic"}>
              <div class="text-14-regular text-text-weak">Connect with Claude Pro/Max or API key</div>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
