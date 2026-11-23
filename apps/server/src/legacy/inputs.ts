import { logAction, type Queryable, type Tx } from '@contentops/db'
import { parsePpvRegistry, type RegistryClaim, type VaultAlbumEvidence } from '@contentops/legacy'
import { sql } from 'drizzle-orm'

/**
 * Inputs of the import besides the snapshot (SPEC §6.3–6.4, schema §9.7): the export of the PPV
 * registry, the vault album titles the agent read in Hub (evidence for SXT-010/011) and the
 * model's list of what is not content (`legacy.not_content`: paths of folders or files the
 * import takes no draft of — an inventory, test uploads, cards inside an order's folder). Each is
 * a model row of `policy_settings` set by a command, so the journal keeps who gave it and when;
 * the import reads them as they are at its start.
 */

export const REGISTRY_KEY = 'legacy.registry'
export const VAULT_ALBUMS_KEY = 'legacy.vault_albums'
export const NOT_CONTENT_KEY = 'legacy.not_content'

export function notContentKey(sourceKind?: string): string {
  return sourceKind ? `${NOT_CONTENT_KEY}.${sourceKind}` : NOT_CONTENT_KEY
}

function mergePaths(rows: readonly { value: unknown }[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const paths = (row.value as { paths?: unknown } | null)?.paths
    if (!Array.isArray(paths)) continue
    for (const raw of paths) {
      const path = String(raw)
      if (!seen.has(path)) {
        seen.add(path)
        out.push(path)
      }
    }
  }
  return out
}

export interface ImportInputs {
  registryText: string | null
  registry: RegistryClaim[]
  vaultAlbums: VaultAlbumEvidence[]
  /** Root-relative paths that are not content; empty — none listed. */
  notContent: string[]
}

export async function readInputs(
  q: Queryable,
  modelId: string,
  sourceKind?: string,
): Promise<ImportInputs> {
  const scopedKey = sourceKind ? notContentKey(sourceKind) : null
  const keys = [REGISTRY_KEY, VAULT_ALBUMS_KEY, NOT_CONTENT_KEY, ...(scopedKey ? [scopedKey] : [])]
  const { rows } = await q.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM policy_settings
     WHERE model_id = ${modelId}::uuid AND account_id IS NULL AND item_type IS NULL
       AND key = ANY (${sql.param(keys)}::text[])`)
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null
  const registryText = (value(REGISTRY_KEY) as { text?: string } | null)?.text ?? null
  const albums = (value(VAULT_ALBUMS_KEY) as { albums?: VaultAlbumEvidence[] } | null)?.albums
  const notContentRows = rows.filter(
    (row) => row.key === NOT_CONTENT_KEY || (scopedKey !== null && row.key === scopedKey),
  )
  return {
    registryText,
    registry: registryText ? parsePpvRegistry(registryText) : [],
    vaultAlbums: albums ?? [],
    notContent: mergePaths(notContentRows),
  }
}

/**
 * The model's list of what is not content: merges `legacy.not_content` with
 * `legacy.not_content.<sourceKind>` when a source kind is given.
 */
export async function readNotContent(
  q: Queryable,
  modelId: string,
  sourceKind?: string,
): Promise<string[]> {
  const keys = sourceKind ? [NOT_CONTENT_KEY, notContentKey(sourceKind)] : [NOT_CONTENT_KEY]
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE model_id = ${modelId}::uuid AND account_id IS NULL AND item_type IS NULL
       AND key = ANY (${sql.param(keys)}::text[])`)
  return mergePaths(rows)
}

async function setSetting(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  key: string,
  value: unknown,
) {
  await tx.execute(sql`
    INSERT INTO policy_settings (model_id, key, value, updated_by)
    VALUES (${modelId}::uuid, ${key}, ${JSON.stringify(value)}::jsonb, ${actorId}::uuid)
    ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
       SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now(),
           row_version = policy_settings.row_version + 1
     WHERE policy_settings.value IS DISTINCT FROM excluded.value`)
}

async function dropSetting(tx: Tx, modelId: string, key: string) {
  await tx.execute(sql`
    DELETE FROM policy_settings
     WHERE model_id = ${modelId}::uuid AND account_id IS NULL AND item_type IS NULL
       AND key = ${key}`)
}

export interface InputsChange {
  /** The export as text (Markdown, CSV or TSV); `null` removes it. */
  registry?: string | null
  vault_albums?: VaultAlbumEvidence[] | null
  /** Root-relative paths of folders or files that are not content; `null` or `[]` removes it. */
  not_content?: string[] | null
}

/** Sets the inputs given; the answer counts what the import will read. */
export async function writeInputs(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  change: InputsChange,
): Promise<{ registry_rows: number; vault_albums: number; not_content: number }> {
  if (change.registry !== undefined) {
    if (change.registry === null || change.registry.trim() === '') {
      await dropSetting(tx, modelId, REGISTRY_KEY)
    } else {
      const rows = parsePpvRegistry(change.registry).length
      await setSetting(tx, modelId, actorId, REGISTRY_KEY, { text: change.registry, rows })
    }
  }
  if (change.vault_albums !== undefined) {
    if (change.vault_albums === null || change.vault_albums.length === 0) {
      await dropSetting(tx, modelId, VAULT_ALBUMS_KEY)
    } else {
      await setSetting(tx, modelId, actorId, VAULT_ALBUMS_KEY, { albums: change.vault_albums })
    }
  }
  if (change.not_content !== undefined) {
    // Paths as the source writes them: a part may end with a space (legacy §1).
    const paths = [...new Set((change.not_content ?? []).filter((p) => p.trim() !== ''))]
    if (paths.length === 0) await dropSetting(tx, modelId, NOT_CONTENT_KEY)
    else await setSetting(tx, modelId, actorId, NOT_CONTENT_KEY, { paths })
  }
  const inputs = await readInputs(tx, modelId)
  const counts = {
    registry_rows: inputs.registry.length,
    vault_albums: inputs.vaultAlbums.length,
    not_content: inputs.notContent.length,
  }
  await logAction(tx, {
    modelId,
    subjectKind: 'policy_settings',
    subjectLabel: 'Входы импорта',
    after: {
      'Строк реестра': String(counts.registry_rows),
      'Альбомов vault': String(counts.vault_albums),
      ...(change.not_content !== undefined || counts.not_content > 0
        ? { 'Не контент': String(counts.not_content) }
        : {}),
    },
  })
  return counts
}
