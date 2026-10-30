import type { Queryable, values } from '@contentops/db'
import {
  type CloudSource,
  createDropboxSource,
  createYandexDiskSource,
  dropboxRefreshToken,
} from '@contentops/sources'
import { sql } from 'drizzle-orm'

/** A cloud folder of a model as `sources` keeps it (schema §3.4, SPEC §6.1). */
export interface SourceRow {
  id: string
  modelId: string
  modelCode: string
  modelTimezone: string
  kind: values.CloudSourceKind
  label: string
  rootPath: string
  credentialsRef: string
}

/** The source client of a row, or `null` when its token is not in the environment. */
export type SourceFactory = (source: SourceRow) => CloudSource | null

/**
 * Clients from the environment (SPEC §8: addresses and secrets live there, the database only
 * names the variable). Yandex Disk: the variable is an OAuth token with `disk.read`. Dropbox:
 * the variable is a refresh token of the read-only app `DROPBOX_APP_KEY` (+ optional
 * `DROPBOX_APP_SECRET`); without an app key it is taken as an access token. `*_API_BASE`
 * point a development stack at the fake servers.
 */
export function envSourceFactory(env: Record<string, string | undefined>): SourceFactory {
  return (source) => {
    const secret = env[source.credentialsRef]?.trim()
    if (!secret) return null
    if (source.kind === 'yandex_disk') {
      return createYandexDiskSource({
        token: secret,
        root: source.rootPath,
        ...(env.YDISK_API_BASE ? { apiBase: env.YDISK_API_BASE } : {}),
      })
    }
    const apiBase = env.DROPBOX_API_BASE
    const appKey = env.DROPBOX_APP_KEY?.trim()
    return createDropboxSource({
      token: appKey
        ? dropboxRefreshToken({
            refreshToken: secret,
            appKey,
            ...(env.DROPBOX_APP_SECRET ? { appSecret: env.DROPBOX_APP_SECRET } : {}),
            ...(apiBase ? { apiBase } : {}),
          })
        : secret,
      root: source.rootPath,
      ...(apiBase ? { apiBase } : {}),
      ...(env.DROPBOX_CONTENT_BASE ? { contentBase: env.DROPBOX_CONTENT_BASE } : {}),
    })
  }
}

/** Whether the token variable of a source is set (SPEC §8: otherwise «не настроено»). */
export function hasCredentials(env: Record<string, string | undefined>, source: SourceRow) {
  return Boolean(env[source.credentialsRef]?.trim())
}

interface SourceDbRow extends Record<string, unknown> {
  id: string
  model_id: string
  model_code: string
  timezone: string
  kind: values.CloudSourceKind
  label: string
  root_path: string
  credentials_ref: string
}

function toSource(row: SourceDbRow): SourceRow {
  return {
    id: row.id,
    modelId: row.model_id,
    modelCode: row.model_code,
    modelTimezone: row.timezone,
    kind: row.kind,
    label: row.label,
    rootPath: row.root_path,
    credentialsRef: row.credentials_ref,
  }
}

/** Enabled cloud sources of active models, or of one model. */
export async function cloudSources(q: Queryable, modelId?: string): Promise<SourceRow[]> {
  const { rows } = await q.execute<SourceDbRow>(sql`
    SELECT s.id, s.model_id, m.code AS model_code, m.timezone, s.kind, s.label, s.root_path,
           s.credentials_ref
      FROM sources s JOIN models m ON m.id = s.model_id
     WHERE s.kind IN ('yandex_disk', 'dropbox') AND s.enabled AND m.archived_at IS NULL
       AND (${modelId ?? null}::uuid IS NULL OR s.model_id = ${modelId ?? null}::uuid)
     ORDER BY m.code, s.created_at`)
  return rows.map(toSource)
}

export async function sourceById(q: Queryable, id: string): Promise<SourceRow | undefined> {
  const { rows } = await q.execute<SourceDbRow>(sql`
    SELECT s.id, s.model_id, m.code AS model_code, m.timezone, s.kind, s.label, s.root_path,
           s.credentials_ref
      FROM sources s JOIN models m ON m.id = s.model_id
     WHERE s.id = ${id}::uuid AND s.kind IN ('yandex_disk', 'dropbox')`)
  const [row] = rows
  return row ? toSource(row) : undefined
}
