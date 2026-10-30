import { randomUUID } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import { type Db, logAction, SYSTEM_ACTOR, withActorTx } from './client.ts'

export class ResetPasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResetPasswordError'
  }
}

export interface ResetPasswordResult {
  /** Sessions of the person that were still alive and are revoked now. */
  revokedSessions: number
}

/**
 * Sets a new password of a person from inside the VM (PLAN stage 3: the owner forgot it):
 * every session of that person is revoked, the journal gets a `system` event without the
 * password. The person is not re-enabled if the owner revoked their access.
 */
export async function resetPassword(
  db: Db,
  login: string,
  password: string,
): Promise<ResetPasswordResult> {
  if (password.length < 8) throw new ResetPasswordError('the password needs at least 8 characters')
  const context = {
    actor: SYSTEM_ACTOR('reset-password'),
    action: 'principal.reset_password',
    requestId: randomUUID(),
  }
  const passwordHash = await hash(password)
  return withActorTx(db, context, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE principals SET password_hash = ${passwordHash}, row_version = row_version + 1
       WHERE login = ${login.trim().toLowerCase()} AND kind = 'human'
      RETURNING id`)
    const person = rows[0]
    if (!person) throw new ResetPasswordError(`no person with login ${login}`)
    const revoked = await tx.execute(sql`
      UPDATE sessions SET revoked_at = now()
       WHERE principal_id = ${person.id}::uuid AND revoked_at IS NULL`)
    const revokedSessions = revoked.rowCount ?? 0
    await logAction(tx, {
      modelId: null,
      subjectKind: 'principals',
      subjectId: person.id,
      subjectLabel: login,
      after: { Сессии: `отозваны: ${revokedSessions}` },
    })
    return { revokedSessions }
  })
}
