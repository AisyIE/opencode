import path from "path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import fs from "fs/promises"

const SCHEMA_URL = "https://opencode.ai/config.json"

export type ConfigEdit = {
  path: Array<string | number>
  value: unknown
}

export type ResolveConfigPathOptions = {
  includeDotOpencode?: boolean
}

export class ConfigFileEditError extends Error {
  readonly path: string

  constructor(message: string, configPath: string) {
    super(message)
    this.path = configPath
  }
}

export async function resolveConfigPath(baseDir: string, options?: ResolveConfigPathOptions) {
  const candidates = [path.join(baseDir, "opencode.json"), path.join(baseDir, "opencode.jsonc")]

  if (options?.includeDotOpencode) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return candidate
    }
  }

  return candidates[0]
}

export async function updateConfigFile(
  configPath: string,
  edits: ConfigEdit[],
  options?: { ensureSchema?: boolean },
) {
  const file = Bun.file(configPath)
  let text = "{}"
  if (await file.exists()) {
    text = await file.text()
  }

  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    throw new ConfigFileEditError("Invalid JSONC in config file", configPath)
  }

  let result = text
  const applyEdit = (path: Array<string | number>, value: unknown) => {
    const patch = modify(result, path, value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    })
    result = applyEdits(result, patch)
  }

  const hasSchema = !!parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "$schema")
  if (options?.ensureSchema && !hasSchema) {
    applyEdit(["$schema"], SCHEMA_URL)
  }

  for (const edit of edits) {
    applyEdit(edit.path, edit.value)
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await Bun.write(configPath, result)
  return result
}
