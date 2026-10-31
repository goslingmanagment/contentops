import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createDb, createPool, type Db, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { loadConfig } from './config'
import { enqueueHistoryPass } from './hub/match/auto'
import { enqueueFreeze, freezeRegister } from './intake/freeze'
import { importReportMarkdown } from './legacy/export'
import { BlobStore } from './media/storage'
import { purgeBlob } from './media/storage-ops'
import { renderForTest, stageForTest } from './media/test-runs'
import { enqueueVerifyBlobs, type VerifyReport } from './media/work/verify-blobs'
import { opsAgent, opsPerson, opsPolicy, opsSwitch } from './ops-owner'
import { smokeSetup } from './smoke/setup'

/**
 * Owner's storage commands (SPEC §9.1, schema §5 «Удаление байтов»), run inside the stack:
 *
 *   docker compose exec worker node dist/ops.js verify-blobs [--wait]
 *   docker compose exec worker node dist/ops.js purge-blobs --report <work id> [--yes]
 *
 * `verify-blobs` puts a run for the `worker` role and, with `--wait`, prints its report.
 * `purge-blobs` removes the unreferenced blobs a finished report lists; each one is checked
 * again under its row lock before and after the file goes. Without `--yes` it only lists.
 * `stage` and `render` are test runs before intake (`media/test-runs.ts`).
 *
 * The snapshot of stage 3 (SPEC §6.3, `intake/freeze.ts`), only by this command:
 *
 *   docker compose exec worker node dist/ops.js freeze <model> <source label> [date] [--wait]
 *   docker compose exec -T worker node dist/ops.js freeze-export <model> [date] > register.jsonl
 *
 * `freeze` puts the work `scan:freeze:<date>` (the model's today by default; a repeat finds the
 * same work). `freeze-export` prints the register of a finished snapshot as JSON lines.
 *
 * The legacy import itself runs by the API and the CLI (`contentops import plan|parse`); its
 * report as Markdown, for the owner to read, only by this command and never into git — it
 * holds the real names of the disk:
 *
 *   docker compose exec -T worker node dist/ops.js import-report <model> [plan|reconcile|<work>] > x.md
 *
 * The history pass of the Fansly pages with «Автосверка» on, again after a batch of the library
 * (SPEC §7; stages 7, 9a and «Старый формат» 9b) — one `hub_history` work per page:
 *
 *   docker compose exec worker node dist/ops.js hub-history <model> [page]
 *
 * The smoke checks of stage 6 (`ops/smoke.sh`, `smoke/setup.ts`): the model `smoke`, its
 * contractor and the smoke agent; `--token` prints a new token of the agent once:
 *
 *   docker compose exec -T worker node dist/ops.js smoke-setup [--token]
 *
 * What «Агенты и токены» and «Интеграции» do, from the VM shell (`ops-owner.ts`): an agent
 * (manager or reader) by its name with its models and, with `--token`, a new token printed
 * once; the switches of an integration by its id:
 *
 *   docker compose exec -T worker node dist/ops.js agent <name> --role manager --models lora [--token]
 *   docker compose exec -T worker node dist/ops.js switch ydisk.lora scan=on
 *
 * A value of «Пороги» by its key, and the settings without a screen (`hub_ad_markers` of a page,
 * `import_batch_scope` of a model); `off` — not set:
 *
 *   docker compose exec -T worker node dist/ops.js policy hub_candidate_tolerance 30
 *   docker compose exec -T worker node dist/ops.js policy hub_ad_markers '{"tags":["#ads"]}' --page lora-1
 */

const USAGE = `usage:
  ops.js verify-blobs [--wait]
  ops.js purge-blobs --report <work id> [--yes]
  ops.js stage <file> --model <code>       (test runs before stage 3)
  ops.js render <sha256> --model <code> [--keep-metadata]
  ops.js freeze <model> <source label> [YYYY-MM-DD] [--wait]
  ops.js freeze-export <model> [YYYY-MM-DD]
  ops.js import-report <model> [plan|reconcile|<work id>]   (Markdown, out of git)
  ops.js hub-history <model> [page]        (the Hub history pass again after a library batch)
  ops.js smoke-setup [--token]             (the smoke model and agent; a new token once)
  ops.js agent <name> --role manager|reader --models <a,b> [--token]   (a new token once)
  ops.js person <login> --name <имя> --role manager|reader --models <a,b>   (a temporary password once)
  ops.js switch <integration> <switch>=on|off ...   (ydisk.lora scan=on, agents enabled=on)
  ops.js policy <key> <json|off> [--model <m>] [--page <p>] [--type PPV]   (thresholds, hub_ad_markers…)`

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function waitFor<R = VerifyReport>(
  db: Db,
  id: string,
  label = 'verify-blobs',
): Promise<{ state: string; report: R | null; paused_reason: string | null }> {
  for (;;) {
    const { rows } = await db.execute<{
      state: string
      report: R | null
      paused_reason: string | null
      num: string | null
      den: string | null
      note: string | null
    }>(sql`
      SELECT state, report, paused_reason, progress_num AS num, progress_den AS den,
             progress_note AS note
        FROM work_operations WHERE id = ${id}::uuid`)
    const row = rows[0]
    if (!row) throw new Error(`no work ${id}`)
    // A switched-off area holds the work until it is switched on: nothing to wait for here.
    if (['succeeded', 'failed', 'cancelled'].includes(row.state) || row.paused_reason) return row
    if (row.num !== null) {
      process.stderr.write(`${label}: ${row.num} / ${row.den ?? '?'} ${row.note ?? ''}\n`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      wait: { type: 'boolean' },
      report: { type: 'string' },
      yes: { type: 'boolean' },
      model: { type: 'string' },
      'keep-metadata': { type: 'boolean' },
      token: { type: 'boolean' },
      role: { type: 'string' },
      models: { type: 'string' },
      name: { type: 'string' },
      page: { type: 'string' },
      type: { type: 'string' },
    },
    allowPositionals: true,
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
      const uploads = run.report.abandoned_uploads ?? []
      if (!values.yes) {
        out({
          would_remove: listed.length,
          bytes: run.report.unreferenced_bytes,
          blobs: listed,
          abandoned_uploads: uploads,
        })
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
      // Abandoned web uploads (SPEC §9.1): checked again under the row — never one that
      // became a blob since the report — then the tus folder goes and the upload is `abandoned`.
      const removedUploads: string[] = []
      for (const upload of uploads) {
        const gone = await withActorTx(
          db,
          {
            actor: SYSTEM_ACTOR('owner purge'),
            action: 'upload.purge',
            requestId: `purge:${values.report}:${upload.upload_id}`,
          },
          async (tx) => {
            const { rows: live } = await tx.execute<{ id: string }>(sql`
              SELECT id FROM web_uploads
               WHERE model_id = ${upload.model_id}::uuid AND upload_id = ${upload.upload_id}
                 AND sha256 IS NULL AND state <> 'registered'
               FOR UPDATE`)
            if (!live[0]) return false
            await rm(dirname(join(config.DATA_ROOT as string, upload.key)), {
              recursive: true,
              force: true,
            })
            await tx.execute(sql`
              UPDATE web_uploads SET state = 'abandoned', error = coalesce(error, 'удалено командой владельца')
               WHERE id = ${live[0].id}::uuid`)
            return true
          },
        )
        if (gone) removedUploads.push(upload.upload_id)
      }
      out({ outcomes, abandoned_uploads_removed: removedUploads })
      return 0
    }
    if (command === 'freeze') {
      const [model, label, date] = positionals
      if (!model || !label) throw new Error(USAGE)
      const queued = await enqueueFreeze(db, {
        model,
        source: label,
        ...(date ? { date } : {}),
      })
      const { work } = queued
      process.stderr.write(
        `freeze: ${work.workKey} of «${queued.source.label}», work ${work.id}` +
          `${queued.created ? '' : ` (already ${work.state})`}\n`,
      )
      if (!values.wait) {
        out({ operation_id: work.id, work_key: work.workKey, state: work.state })
        return 0
      }
      const done = await waitFor(db, work.id, 'freeze')
      out({ operation_id: work.id, ...done })
      return done.state === 'succeeded' ? 0 : 1
    }
    if (command === 'smoke-setup') {
      const result = await smokeSetup(db, {
        token: values.token === true,
        log: (line) => process.stderr.write(`${line}\n`),
      })
      if (!result.agents_enabled) {
        process.stderr.write(
          'smoke-setup: «Агенты» are off (Настройки › Интеграции): the token is refused until the owner turns them on\n',
        )
      }
      out(result)
      return 0
    }
    if (command === 'agent') {
      const [name] = positionals
      if (!name || !values.role || !values.models) throw new Error(USAGE)
      const result = await opsAgent(db, {
        name,
        role: values.role,
        models: values.models
          .split(',')
          .map((code) => code.trim())
          .filter(Boolean),
        token: values.token === true,
      })
      if (!result.agents_enabled) {
        process.stderr.write(
          'agent: «Агенты» are off: the token is refused until `ops.js switch agents enabled=on`\n',
        )
      }
      out(result)
      return 0
    }
    if (command === 'person') {
      const [login] = positionals
      if (!login || !values.name || !values.role || !values.models) throw new Error(USAGE)
      out(
        await opsPerson(db, {
          login,
          name: values.name,
          role: values.role,
          models: values.models
            .split(',')
            .map((code) => code.trim())
            .filter(Boolean),
        }),
      )
      return 0
    }
    if (command === 'switch') {
      const [integration, ...pairs] = positionals
      if (!integration || pairs.length === 0) throw new Error(USAGE)
      out({ integration, switches: await opsSwitch(db, integration, pairs) })
      return 0
    }
    if (command === 'policy') {
      const [key, value] = positionals
      if (!key || value === undefined) throw new Error(USAGE)
      out(
        await opsPolicy(db, {
          key,
          value,
          model: values.model,
          page: values.page,
          type: values.type,
        }),
      )
      return 0
    }
    if (command === 'hub-history') {
      const [model, account] = positionals
      if (!model) throw new Error(USAGE)
      const queued = await enqueueHistoryPass(db, { model, account: account ?? null })
      out(queued)
      return 0
    }
    if (command === 'freeze-export') {
      const [model, date] = positionals
      if (!model) throw new Error(USAGE)
      for await (const line of freezeRegister(db, { model, ...(date ? { date } : {}) })) {
        if (!process.stdout.write(`${JSON.stringify(line)}\n`)) {
          await new Promise((resolve) => process.stdout.once('drain', resolve))
        }
      }
      return 0
    }
    if (command === 'import-report') {
      const [model, work] = positionals
      if (!model) throw new Error(USAGE)
      process.stdout.write(await importReportMarkdown(db, model, work ?? null))
      return 0
    }
    if (command === 'stage' || command === 'render') {
      const store = new BlobStore({
        dataRoot: config.DATA_ROOT as string,
        derivedRoot: config.DERIVED_ROOT as string,
        tmpRoot: config.TMP_ROOT as string,
      })
      const model = values.model
      const target = positionals[0]
      if (!model || !target) throw new Error(USAGE)
      const out =
        command === 'stage'
          ? await stageForTest(db, store, model, target)
          : await renderForTest(db, model, target, values['keep-metadata'] !== true)
      out && process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
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
