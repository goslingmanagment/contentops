import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { createDb, createPool, type Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { loadConfig } from './config'
import { BlobStore } from './media/storage'
import { purgeBlob } from './media/storage-ops'
import { enqueueVerifyBlobs, type VerifyReport } from './media/work/verify-blobs'

/**
 * Owner's storage commands (SPEC §9.1, schema §5 «Удаление байтов»), run inside the stack:
 *
 *   docker compose exec worker node dist/ops.js verify-blobs [--wait]
 *   docker compose exec worker node dist/ops.js purge-blobs --report <work id> [--yes]
 *
 * `verify-blobs` puts a run for the `worker` role and, with `--wait`, prints its report.
 * `purge-blobs` removes the unreferenced blobs a finished report lists; each one is checked
 * again under its row lock before and after the file goes. Without `--yes` it only lists.
 */

const USAGE = `usage:
  ops.js verify-blobs [--wait]
  ops.js purge-blobs --report <work id> [--yes]`

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function waitFor(
  db: Db,
  id: string,
): Promise<{ state: string; report: VerifyReport | null }> {
  for (;;) {
    const { rows } = await db.execute<{
      state: string
      report: VerifyReport | null
      num: string | null
      den: string | null
    }>(sql`
      SELECT state, report, progress_num AS num, progress_den AS den FROM work_operations WHERE id = ${id}::uuid`)
    const row = rows[0]
    if (!row) throw new Error(`no work ${id}`)
    if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return row
    if (row.num !== null) process.stderr.write(`verify-blobs: ${row.num} / ${row.den ?? '?'}\n`)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: { wait: { type: 'boolean' }, report: { type: 'string' }, yes: { type: 'boolean' } },
  })
  const config = loadConfig({ ...process.env, ROLE: 'worker' })
  const pool = createPool(config.DATABASE_URL as string, { max: 2, applicationName: 'ops' })
  const db = createDb(pool)
  try {
    if (command === 'verify-blobs') {
      const { work, created } = await enqueueVerifyBlobs(db)
      process.stderr.write(`verify-blobs: work ${work.id}${created ? '' : ' (already running)'}\n`)
      if (!values.wait) {
        out({ operation_id: work.id })
        return 0
      }
      const done = await waitFor(db, work.id)
      out({ operation_id: work.id, state: done.state, report: done.report })
      return done.state === 'succeeded' ? 0 : 1
    }
    if (command === 'purge-blobs') {
      if (!values.report) throw new Error(USAGE)
      const { rows } = await db.execute<{ state: string; report: VerifyReport | null }>(sql`
        SELECT state, report FROM work_operations
         WHERE id = ${values.report}::uuid AND kind = 'verify_blobs'`)
      const run = rows[0]
      if (run?.state !== 'succeeded' || !run.report) {
        throw new Error('the report is not a finished verify-blobs run')
      }
      const listed = run.report.unreferenced
      if (!values.yes) {
        out({ would_remove: listed.length, bytes: run.report.unreferenced_bytes, blobs: listed })
        return 0
      }
      const store = new BlobStore({
        dataRoot: config.DATA_ROOT as string,
        derivedRoot: config.DERIVED_ROOT as string,
        tmpRoot: config.TMP_ROOT as string,
      })
      const outcomes: Record<string, string> = {}
      for (const blob of listed) {
        outcomes[blob.sha256] = await purgeBlob(
          db,
          store,
          blob.sha256,
          `owner:${hostname()}:${process.pid}`,
        )
      }
      out({ outcomes })
      return 0
    }
    process.stderr.write(`${USAGE}\n`)
    return 2
  } finally {
    await pool.end()
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
