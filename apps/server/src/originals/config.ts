import { isSwitchOn, type Queryable, type values } from '@contentops/db'
import { nfc } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Where a model's originals and their copies live for rclone (SPEC §9.4, ops/README.md
 * «Оригиналы: два места»): a value of `policy_settings` per model, key `originals.model_config`,
 * set by the owner (`ops.js policy originals.model_config '{…}' --model <m>`). No model name is
 * written in code: a model without the value is not checked. Example of Lora:
 *
 *   {"yandex_disk": "yadisk-lora:", "dropbox": "dropbox-lora:", "mega": "mega:originals/lora",
 *    "copies": {"yandex_disk": "yadisk", "dropbox": "dropbox"},
 *    "exclude": {"yandex_disk": ["_ydisk-test"], "dropbox": ["Архив Я.Диска"]},
 *    "pc": ["ydisk_copy"]}
 *
 * - `yandex_disk`, `dropbox` — the rclone remote of the root of the model's source of that kind:
 *   the nightly audit lists it and checks the origins by the hash of the list;
 * - `mega` — the folder of the model's copies in MEGA: the audit lists it;
 * - `copies` — a new original of that source kind gets a MEGA copy row at
 *   `<mega>/<folder>/<its path in the source>` (Lora: the nightly copy of her Я.Диск and Dropbox).
 *   Without it no row is made by itself (Ari: the rows come from her manifest, `originals seed`);
 * - `exclude` — folders of the source that are not copied into MEGA (as the copy itself skips them);
 * - `pc` — where the originals of the model lie on the PC: `ydisk_copy` — the copy of Я.Диск on C:,
 *   `e_ari` — the mirror of Dropbox on E:. Their files are checked first, and their host lists say
 *   what is freed.
 */

export const MODEL_CONFIG_KEY = 'originals.model_config'

/** The switch of the check and the audit: `ops.js originals on|off`, no screen. */
export const SWITCH_KEY = 'originals.enabled' satisfies values.KillSwitchKey

/** The place on the PC, the source kind it holds and the summary of its list in the host share. */
export const PC_HOLDERS = {
  ydisk_copy: { kind: 'yandex_disk', meta: 'ydisk-copy-list.meta.json', label: 'копии Я.Диска' },
  e_ari: { kind: 'dropbox', meta: 'ari-copy-list.meta.json', label: 'E:\\Ari' },
} as const
export type PcHolder = keyof typeof PC_HOLDERS

export type OriginKind = 'yandex_disk' | 'dropbox'

const REMOTE_NAME = /^[A-Za-z0-9_.-]+$/u

/** `name:` or `name:folder` — an rclone remote and a folder in it. */
const RemoteSpec = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+:[^\0]*$/u, 'ожидается «remote:» или «remote:папка»')
  .transform((value) => {
    const at = value.indexOf(':')
    return { remote: value.slice(0, at), path: trimSlashes(value.slice(at + 1)) }
  })

const Folder = z
  .string()
  .min(1)
  .transform(trimSlashes)
  .refine((value) => value !== '' && !value.split('/').includes('..'), 'папка без «..»')

const ModelConfigSchema = z.strictObject({
  yandex_disk: RemoteSpec.optional(),
  dropbox: RemoteSpec.optional(),
  mega: RemoteSpec.optional(),
  copies: z
    .strictObject({ yandex_disk: Folder.optional(), dropbox: Folder.optional() })
    .default({}),
  exclude: z
    .strictObject({
      yandex_disk: z.array(Folder).default([]),
      dropbox: z.array(Folder).default([]),
    })
    .default({ yandex_disk: [], dropbox: [] }),
  pc: z.array(z.enum(Object.keys(PC_HOLDERS) as [PcHolder, ...PcHolder[]])).default([]),
})

export type RemoteRef = { remote: string; path: string }
export type ModelConfig = z.output<typeof ModelConfigSchema>

export interface ConfiguredModel {
  id: string
  code: string
  config: ModelConfig
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/gu, '')
}

export function isRemoteName(name: string): boolean {
  return REMOTE_NAME.test(name)
}

/** The value as the owner wrote it, or why it is not a configuration. */
export function parseModelConfig(
  value: unknown,
): { ok: true; config: ModelConfig } | { ok: false; error: string } {
  const parsed = ModelConfigSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') }
  }
  const config = parsed.data
  if (Object.keys(config.copies).length > 0 && !config.mega) {
    return { ok: false, error: '«copies» без «mega»: не знаю, куда класть строки копий' }
  }
  return { ok: true, config }
}

/**
 * The models with a valid configuration whose switch is on (`originals.enabled`, the model's
 * own level included): the works go over them only. Broken values are returned apart.
 */
export async function configuredModels(
  q: Queryable,
  options: { all?: boolean } = {},
): Promise<{ models: ConfiguredModel[]; broken: { code: string; error: string }[] }> {
  const { rows } = await q.execute<{ id: string; code: string; value: unknown }>(sql`
    SELECT m.id, m.code, p.value FROM policy_settings p JOIN models m ON m.id = p.model_id
     WHERE p.key = ${MODEL_CONFIG_KEY} AND p.account_id IS NULL AND p.item_type IS NULL
       AND p.value IS NOT NULL AND m.archived_at IS NULL
     ORDER BY m.code`)
  const models: ConfiguredModel[] = []
  const broken: { code: string; error: string }[] = []
  for (const row of rows) {
    const parsed = parseModelConfig(row.value)
    if (!parsed.ok) {
      broken.push({ code: row.code, error: parsed.error })
      continue
    }
    if (!options.all && !(await isSwitchOn(q, SWITCH_KEY, { modelId: row.id }))) continue
    models.push({ id: row.id, code: row.code, config: parsed.config })
  }
  return { models, broken }
}

/** Path components compared as the cloud compares them: NFC, Dropbox without case. */
export function pathKey(path: string, kind: OriginKind | 'mega'): string {
  const form = nfc(trimSlashes(path))
  return kind === 'dropbox' ? form.toLowerCase() : form
}

/** The path is one of the folders or inside one (relative to the source's root). */
export function isExcluded(relative: string, folders: readonly string[], kind: OriginKind) {
  const key = pathKey(relative, kind)
  return folders.some((folder) => {
    const f = pathKey(folder, kind)
    return key === f || key.startsWith(`${f}/`)
  })
}

/** `remote:path` as rclone writes it, for messages. */
export function remoteText(ref: RemoteRef): string {
  return `${ref.remote}:${ref.path}`
}

export function joinPath(...parts: string[]): string {
  return parts
    .map(trimSlashes)
    .filter((part) => part !== '')
    .join('/')
}
