import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Auth } from "../../auth"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Global } from "../../global"
import { Instance } from "../../project/instance"
import { type ConfigEdit, ConfigFileEditError, resolveConfigPath, updateConfigFile } from "../../config/config-file"

const log = Log.create({ service: "server" })

const PresetId = z.enum(["openai-responses", "openai-classic", "anthropic", "gemini"])
type PresetId = z.infer<typeof PresetId>
const PresetScope = z.enum(["global", "project"])

const PresetCatalog: Record<
  PresetId,
  {
    providerID: string
    defaultBaseURL: string
    useChatCompletions?: boolean
  }
> = {
  "openai-responses": {
    providerID: "openai",
    defaultBaseURL: "https://api.openai.com/v1",
    useChatCompletions: false,
  },
  "openai-classic": {
    providerID: "openai",
    defaultBaseURL: "https://api.openai.com/v1",
    useChatCompletions: true,
  },
  anthropic: {
    providerID: "anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
  },
  gemini: {
    providerID: "google",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
  },
}

const BaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      return false
    }
  }, "Invalid baseURL")

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.get())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .post(
      "/provider-presets/apply",
      describeRoute({
        summary: "Apply provider preset",
        description: "Apply a provider preset by writing config options and storing API key credentials.",
        operationId: "config.providerPresets.apply",
        responses: {
          200: {
            description: "Preset applied",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    providerID: z.string(),
                    scope: PresetScope,
                    configPath: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          preset: PresetId,
          scope: PresetScope,
          baseURL: BaseUrlSchema,
          apiKey: z.string().trim().min(1),
        }),
      ),
      async (c) => {
        const { preset, scope, baseURL, apiKey } = c.req.valid("json")
        const presetInfo = PresetCatalog[preset]
        const providerID = presetInfo.providerID

        const projectRoot = Instance.project.vcs === "git" ? Instance.worktree : Instance.directory
        const baseDir = scope === "global" ? Global.Path.config : projectRoot
        const configPath = await resolveConfigPath(baseDir, { includeDotOpencode: scope === "project" })

        const edits: ConfigEdit[] = [
          {
            path: ["provider", providerID, "options", "baseURL"],
            value: baseURL,
          },
        ]
        if (presetInfo.useChatCompletions !== undefined) {
          edits.push({
            path: ["provider", "openai", "options", "useChatCompletions"],
            value: presetInfo.useChatCompletions,
          })
        }

        await Auth.set(providerID, { type: "api", key: apiKey })
        try {
          await updateConfigFile(configPath, edits, { ensureSchema: true })
        } catch (error) {
          await Auth.remove(providerID).catch(() => {})
          if (error instanceof ConfigFileEditError) {
            return c.json({ error: `${error.message}: ${error.path}` }, 400)
          }
          return c.json({ error: "Failed to update config file" }, 400)
        }

        return c.json({
          ok: true,
          providerID,
          scope,
          configPath,
        })
      },
    ),
)
