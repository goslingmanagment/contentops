import { createHash } from 'node:crypto'
import type { ToolVersions } from './tools.ts'

/**
 * Recipes and `recipe_digest` (SPEC §9.1, schema `pipeline_versions`): every kind of output
 * — the master too — has a canonical JSON of its profile plus the versions of exactly the
 * tools that build it. The digest is the SHA-256 of that JSON, so editing one recipe (say,
 * thumbnails) changes only that kind's digest and rebuilds only that kind.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined }

/** `rendition_generations.kind` (schema §3.3). */
export type RenditionKind =
  | 'preview'
  | 'poster'
  | 'thumb320'
  | 'thumb640'
  | 'preview2048'
  | 'frames'
  | 'platform'

export type RecipeKind =
  | RenditionKind
  | 'master'
  | 'probe'
  | 'phash'
  | 'uniq'
  | 'compatible'
  | 'strip'

export type ToolName = keyof ToolVersions

export interface Recipe {
  kind: RecipeKind
  media: 'video' | 'photo'
  profile: JsonValue
  tools: Partial<Record<ToolName, string | null>>
}

/** JSON with sorted keys and no whitespace; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member !== undefined) out[key] = sortValue(member)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('recipe values must be finite numbers')
  }
  return value
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function recipe(
  kind: RecipeKind,
  media: Recipe['media'],
  profile: JsonValue,
  versions: ToolVersions,
  tools: readonly ToolName[],
): Recipe {
  const picked: Recipe['tools'] = {}
  for (const tool of tools) picked[tool] = versions[tool]
  return { kind, media, profile, tools: picked }
}

export function recipeDigest(value: Recipe): string {
  return sha256Hex(canonicalJson(value))
}

export interface DigestedRecipe {
  recipe: Recipe
  digest: string
}

export function digested(value: Recipe): DigestedRecipe {
  return { recipe: value, digest: recipeDigest(value) }
}
