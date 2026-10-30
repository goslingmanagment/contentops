import { logAction, type Queryable, type Tx } from '@contentops/db'
import { parsePpvRegistry, type RegistryClaim, type VaultAlbumEvidence } from '@contentops/legacy'
import { sql } from 'drizzle-orm'

/**
 * Inputs of the import besides the snapshot (SPEC §6.3–6.4, schema §9.7): the export of the PPV
 * registry and the vault album titles the agent read in Hub (evidence for SXT-010/011). Each is
 * a model row of `policy_settings` set by a command, so the journal keeps who gave it and when;
 * the import reads them as they are at its start.
 */

export const REGISTRY_KEY = 'legacy.registry'
export const VAULT_ALBUMS_KEY = 'legacy.vault_albums'

export interface ImportInputs {
  registryText: string | null
  registry: RegistryClaim[]
  vaultAlbums: VaultAlbumEvidence[]
}

export async function readInputs(q: Queryable, modelId: string): Promise<ImportInputs> {
  const { rows } = await q.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM policy_settings
     WHERE model_id = ${modelId}::uuid AND account_id IS NULL AND item_type IS NULL
       AND key IN (${REGISTRY_KEY}, ${VAULT_ALBUMS_KEY})`)
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null
  const registryText = (value(REGISTRY_KEY) as { text?: string } | null)?.text ?? null
  const albums = (value(VAULT_ALBUMS_KEY) as { albums?: VaultAlbumEvidence[] } | null)?.albums
  return {
    registryText,
    registry: registryText ? parsePpvRegistry(registryText) : [],
    vaultAlbums: albums ?? [],
  }
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
}

/** Sets the inputs given; the answer counts what the import will read. */
export async function writeInputs(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  change: InputsChange,
): Promise<{ registry_rows: number; vault_albums: number }> {
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
  const inputs = await readInputs(tx, modelId)
  const counts = { registry_rows: inputs.registry.length, vault_albums: inputs.vaultAlbums.length }
  await logAction(tx, {
    modelId,
    subjectKind: 'policy_settings',
    subjectLabel: 'Входы импорта',
    after: {
      'Строк реестра': String(counts.registry_rows),
      'Альбомов vault': String(counts.vault_albums),
    },
  })
  return counts
}
