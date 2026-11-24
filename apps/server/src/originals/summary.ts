import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Db, isSwitchOn } from '@contentops/db'
import { COPY_LIST_FILE } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { instant } from '../commands'
import { copyList } from '../legacy/copy'
import type { AuditReport } from './audit'
import { configuredModels, PC_HOLDERS, type PcHolder, SWITCH_KEY } from './config'
import type { CopyReport } from './copy'
import { originalStates } from './rule'

/**
 * The line «Оригиналы» of «Настройки › Состояние» (SPEC §9.4): «надёжны N из M · ждут
 * проверки K · на ПК освобождено Y ГБ · копий не найдено Z», and ▲ with its reasons — copies not
 * found or bytes that did not match; MEGA or a Dropbox under 10 % free; no nightly audit for
 * more than 36 hours while the switch is on; a listing of the audit that broke; something on the
 * PC may go, but the host's list of that place is older than 2 hours (the release on Windows
 * waits for it, PR3); the copy refuses a folder of a Dropbox that the model's policy does not
 * keep apart yet. «Освобождено» is what the lists of the PC show gone among the originals
 * that may go — the copy of Я.Диск (a file without its bytes) — plus web uploads released from
 * our disk. Counts only, no paths.
 */

export interface OriginalsLine {
  originals: number
  reliable: number
  waiting: number
  freed_bytes: number
  missing: number
  failed: number
  warnings: string[]
  audited_at: string | null
}

export const AUDIT_STALE_MS = 36 * 60 * 60_000
export const LIST_STALE_MS = 2 * 60 * 60_000
const LOW_FREE = 0.1

interface HostMeta {
  finished_at?: unknown
}

async function readMeta(file: string): Promise<HostMeta | null | 'absent'> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return 'absent'
  }
  try {
    return JSON.parse(text.replace(/^﻿/u, '')) as HostMeta
  } catch {
    return null
  }
}

function finishedAt(meta: HostMeta | null): number | null {
  const at = typeof meta?.finished_at === 'string' ? Date.parse(meta.finished_at) : Number.NaN
  return Number.isNaN(at) ? null : at
}

function percent(free: number, total: number): string {
  return `${Math.max(0, Math.floor((free / total) * 100))} %`
}

export async function originalsLine(
  db: Db,
  options: { hostDir: string | undefined; now?: Date },
): Promise<OriginalsLine | null> {
  const now = options.now ?? new Date()
  const { rows: ledger } = await db.execute<{
    rows: string
    waiting: string
    missing: string
    failed: string
  }>(sql`
    SELECT count(*)::text AS rows,
           count(*) FILTER (WHERE verified_at IS NULL AND missing_since IS NULL
                              AND object_ref IS NOT NULL)::text AS waiting,
           count(missing_since)::text AS missing,
           count(*) FILTER (WHERE verified_at IS NULL AND missing_since IS NULL
                              AND error LIKE 'mismatch:%')::text AS failed
      FROM original_copies`)
  const counts = ledger[0]
  if (!counts || Number(counts.rows) === 0) return null

  const { rows: models } = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT m.id FROM models m JOIN original_copies c ON c.model_id = m.id
     WHERE m.archived_at IS NULL`)
  const { models: configured } = await configuredModels(db, { all: true })
  const holdersOf = new Map(configured.map((model) => [model.id, model.config.pc]))
  const list = options.hostDir ? await copyList(join(options.hostDir, COPY_LIST_FILE)) : null

  let originals = 0
  let reliable = 0
  let freed = 0
  const onPc: Record<PcHolder, number> = { ydisk_copy: 0, e_ari: 0 }
  for (const { id } of models) {
    const holders = holdersOf.get(id) ?? []
    for (const state of await originalStates(db, id)) {
      if (state.released) continue
      originals += 1
      if (state.reliable) reliable += 1
      if (!state.releasable) continue
      for (const holder of holders) {
        if (PC_HOLDERS[holder].kind !== state.holder) continue
        const file = holder === 'ydisk_copy' ? list?.fileOf(state.path) : null
        if (file && !file.bytesPresent) freed += Number(state.byte_size)
        else onPc[holder] += 1
      }
    }
  }
  const { rows: uploads } = await db.execute<{ bytes: string | null }>(sql`
    SELECT sum(size_expected)::text AS bytes FROM web_uploads WHERE raw_released_at IS NOT NULL`)
  freed += Number(uploads[0]?.bytes ?? 0)

  const missing = Number(counts.missing)
  const failed = Number(counts.failed)
  const warnings: string[] = []
  if (missing > 0) warnings.push(`копий не найдено: ${missing}`)
  if (failed > 0) warnings.push(`байты не сошлись: ${failed}`)

  const { rows: audits } = await db.execute<{ finished_at: string; report: AuditReport | null }>(
    sql`
    SELECT finished_at::text AS finished_at, report FROM work_operations
     WHERE kind = 'originals_audit' AND state = 'succeeded'
     ORDER BY finished_at DESC LIMIT 1`,
  )
  const audit = audits[0]
  const auditedAt = audit ? new Date(instant(audit.finished_at)) : null
  const report = audit?.report ?? null
  for (const space of report?.space ?? []) {
    if (space.free_bytes === null || !space.total_bytes) continue
    if (space.free_bytes / space.total_bytes < LOW_FREE) {
      const where = space.place === 'mega' ? 'MEGA' : `Dropbox ${space.remote}`
      warnings.push(
        `мало места: ${where} — свободно ${percent(space.free_bytes, space.total_bytes)}`,
      )
    }
  }
  for (const listing of report?.listings ?? []) {
    if (!listing.complete) warnings.push(`сверка: список ${listing.remote} оборвался`)
  }
  const { rows: copies } = await db.execute<{ report: CopyReport | null }>(sql`
    SELECT report FROM work_operations
     WHERE kind = 'originals_copy' AND state = 'succeeded'
     ORDER BY finished_at DESC LIMIT 1`)
  for (const refused of copies[0]?.report?.refused ?? []) {
    const why = refused.why.includes('exclude.dropbox')
      ? 'её нет в exclude.dropbox'
      : refused.why.includes('not_content')
        ? 'её нет в legacy.not_content.dropbox'
        : 'не та папка'
    warnings.push(`копия ${refused.model}: в «${refused.folder}» не пишем — ${why}`)
  }
  if (await isSwitchOn(db, SWITCH_KEY)) {
    if (!auditedAt || now.getTime() - auditedAt.getTime() > AUDIT_STALE_MS) {
      warnings.push('ночной сверки не было больше 36 ч')
    }
  }
  for (const holder of Object.keys(onPc) as PcHolder[]) {
    if (onPc[holder] === 0 || !options.hostDir) continue
    const meta = await readMeta(join(options.hostDir, PC_HOLDERS[holder].meta))
    // The list of E:\Ari comes with its task; until then there is nothing to wait for.
    if (meta === 'absent' && holder !== 'ydisk_copy') continue
    const at = meta === 'absent' ? null : finishedAt(meta)
    if (at === null || now.getTime() - at > LIST_STALE_MS) {
      warnings.push(`список ${PC_HOLDERS[holder].label} старше 2 ч — ждёт входа dmsrg`)
    }
  }
  return {
    originals,
    reliable,
    waiting: Number(counts.waiting),
    freed_bytes: freed,
    missing,
    failed,
    warnings,
    audited_at: auditedAt ? auditedAt.toISOString() : null,
  }
}

const CACHE_MS = 60_000
let cache: { key: string; at: number; value: OriginalsLine | null } | null = null
let pending: Promise<OriginalsLine | null> | null = null

/**
 * The line for the screen, polled every 10 s: computed at most once a minute, the previous value
 * served while a new one is computed.
 */
export async function cachedOriginalsLine(
  db: Db,
  options: { hostDir: string | undefined },
): Promise<OriginalsLine | null> {
  const key = options.hostDir ?? ''
  const fresh = cache && cache.key === key && Date.now() - cache.at < CACHE_MS
  if (fresh) return cache?.value ?? null
  if (!pending) {
    pending = originalsLine(db, options)
      .then((value) => {
        cache = { key, at: Date.now(), value }
        return value
      })
      .finally(() => {
        pending = null
      })
  }
  if (cache && cache.key === key) {
    pending.catch(() => {})
    return cache.value
  }
  return pending
}
