import { rm } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { Services } from '../services'

/**
 * Staged sources (`TMP_ROOT/staging`) of a decided group are not needed any more: the master
 * is a blob. Best effort after the commit; a file still used by another open draft stays.
 */
export async function dropStagedOfGroup(services: Services, modelId: string, groupId: string) {
  const { rows } = await services.db.execute<{ sha: string }>(sql`
    SELECT DISTINCT encode(d.source_sha256, 'hex') AS sha FROM inbox_drafts d
     WHERE d.model_id = ${modelId}::uuid AND d.group_id = ${groupId}::uuid
       AND d.state = 'resolved' AND d.source_sha256 IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM inbox_drafts o
                        WHERE o.source_sha256 = d.source_sha256 AND o.state <> 'resolved')`)
  for (const { sha } of rows) {
    const staged = await services.store.staged(sha).catch(() => null)
    if (staged) await rm(staged.path, { force: true }).catch(() => {})
  }
}
