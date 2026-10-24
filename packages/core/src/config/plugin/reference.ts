export * as ConfigReferencePlugin from "./reference"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { ConfigReference } from "../reference"
import { Reference } from "../../reference"
import { AbsolutePath } from "../../schema"
import { Global } from "../../global"
import { Location } from "../../location"

export const Plugin = define({
  id: "core/config-reference",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    yield* ctx.reference.transform(
      Effect.fn(function* (draft) {
        const entries = new Map<string, Reference.Source>()
        for (const doc of (yield* config.entries()).filter(
          (entry): entry is Config.Document => entry.type === "document",
        )) {
          const directory = doc.path ? path.dirname(doc.path) : location.directory
          for (const [name, entry] of Object.entries(doc.info.references ?? {})) {
            if (!validAlias(name)) continue
            const description = typeof entry === "string" ? undefined : entry.description
            const hidden = typeof entry === "string" ? undefined : entry.hidden
            entries.set(
              name,
              local(entry)
                ? Reference.LocalSource.make({
                    type: "local",
                    path: AbsolutePath.make(
                      localPath(directory, global.home, typeof entry === "string" ? entry : entry.path),
                    ),
                    ...(description === undefined ? {} : { description }),
                    ...(hidden === undefined ? {} : { hidden }),
                  })
                : Reference.GitSource.make({
                    type: "git",
                    repository: typeof entry === "string" ? entry : entry.repository,
                    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
                    ...(description === undefined ? {} : { description }),
                    ...(hidden === undefined ? {} : { hidden }),
                  }),
            )
          }
        }
        for (const [name, source] of entries) draft.add(name, source)
      }),
    )
  }),
})

function validAlias(name: string) {
  return name.length > 0 && !/[\/\s`,]/.test(name)
}

function local(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string"
    ? entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~")
    : "path" in entry
}

function localPath(directory: string, home: string, value: string) {
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(directory, value)
}

/**
 * Local reference directories implied by config alone, resolved relative to
 * each document's directory (or the given default directory for stdin config).
 * Consumers that only need the paths — the external_directory whitelist — can
 * call this directly instead of waiting for the plugin transform to land in
 * the shared Reference list.
 */
export function localDirs(input: {
  readonly documents: ReadonlyArray<{ readonly path?: string; readonly references?: ConfigReference.Info }>
  readonly directory: string
  readonly home: string
}): string[] {
  const dirs: string[] = []
  for (const doc of input.documents) {
    const directory = doc.path ? path.dirname(doc.path) : input.directory
    for (const entry of Object.values(doc.references ?? {})) {
      if (!local(entry)) continue
      dirs.push(localPath(directory, input.home, typeof entry === "string" ? entry : entry.path))
    }
  }
  return dirs
}
