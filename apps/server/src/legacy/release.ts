import { readFile } from 'node:fs/promises'
import { formatBytes } from '@contentops/contracts/format'
import type { Db } from '@contentops/db'
import { apiToLocalPath, CopyList, parseCopyList, relativePath } from '@contentops/legacy'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { type OriginalState, originalStates } from '../originals/rule'
import { classify, type Outcome, type Row, rowsOf } from './reconcile'
import { snapshotOf } from './snapshot'

/**
 * «Можно освобождать» (PLAN этап 7, 9а; SPEC §12.2): the roots of the old disk whose local copy
 * may be unpinned in the Я.Диск client — every file of the root is decided by the rule of the
 * originals (`originals/rule.ts`, SPEC §9.4: its master is built and on our disk, accepted or not;
 * or rejected by a person with a reason, an alias of accepted bytes, an archive whose members are
 * decided, not media, not content), and the copy holds nothing the snapshot does not know. For
 * each such root
 * the files with their sizes, the bytes the copy holds (the gain to expect), the object, the
 * SHA-256 of the source bytes the import checked against the snapshot's MD5, and the master.
 *
 * It only reads: the database and the Windows list of the copy (`LEGACY_COPY_LIST`). Unpinning is
 * done file by file by the Windows task `ContentOps-Originals-YDisk` with what the route of the
 * originals gives (`originals/release.ts`); nothing is deleted, the cloud keeps the source.
 * The report names real files: by the operator's command only, never into git.
 */

/**
 * Why a file the rule has not decided keeps its root waiting: the reconciliation's words where it
 * has them, else the rule's reason (an archive not unpacked yet, members still open).
 */
function blockerOf(
  row: Row,
  outcome: Outcome,
  reason: string | null,
  decision: OriginalState | undefined,
): string {
  if (outcome === 'accepted' || outcome === 'alias') {
    if (row.master_state !== 'present') return 'мастер не на месте'
    if (!row.source_sha) return 'байты источника не проверены'
  }
  if (outcome === 'blocked' || outcome === 'waiting' || outcome === 'unexplained') {
    return reason ? `${outcome}:${reason}` : outcome
  }
  return decision?.reason ?? outcome
}

export interface ReleaseFile {
  path: string
  size: number
  /** In an archive: freed with the archive itself. */
  member: boolean
  outcome: Outcome
  reason: string | null
  item: string | null
  source_sha256: string | null
  master: { sha256: string; state: string } | null
  /** What the copy holds: bytes on disk, a placeholder, or nothing (`null` — not in the list). */
  copy: 'bytes' | 'placeholder' | null
}

export interface ReleaseRoot {
  root: string
  files: number
  members: number
  snapshot_bytes: number
  /** Bytes the copy holds on disk for this root: what unpinning gives back. */
  copy_bytes: number
  /** Why the root may not be unpinned yet, counted; empty — it may. */
  blockers: Record<string, number>
  ready: boolean
  rows: ReleaseFile[]
  /** Files of the copy the snapshot does not know, with bytes on disk. */
  outside: { path: string; size: number }[]
}

export interface CopyListMeta {
  finished_at: string | null
  errors: number
  dirs_not_listed: number
  client_running: boolean
}

export interface ReleaseReport {
  model: string
  snapshot: string
  source: string
  copy_list: string | null
  copy_list_meta?: CopyListMeta | null
  roots: ReleaseRoot[]
  ready_bytes: number
}

function metaPathOf(listFile: string): string {
  return /\.jsonl$/i.test(listFile)
    ? listFile.replace(/\.jsonl$/i, '.meta.json')
    : `${listFile}.meta.json`
}

async function readCopyListMeta(
  listFile: string,
): Promise<{ meta: CopyListMeta | null; corrupt: boolean }> {
  let raw: string
  try {
    raw = (await readFile(metaPathOf(listFile), 'utf8')).replace(/^﻿/, '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { meta: null, corrupt: false }
    }
    return { meta: null, corrupt: true }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return { meta: null, corrupt: true }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      meta: {
        finished_at: typeof parsed.finished_at === 'string' ? parsed.finished_at : null,
        errors: num(parsed.errors),
        dirs_not_listed: num(parsed.dirs_not_listed),
        client_running: parsed.client_running === true,
      },
      corrupt: false,
    }
  } catch {
    return { meta: null, corrupt: true }
  }
}

function bump(blockers: Record<string, number>, reason: string) {
  blockers[reason] = (blockers[reason] ?? 0) + 1
}

export async function releaseReport(
  db: Db,
  model: string,
  listFile: string | null,
): Promise<ReleaseReport> {
  const { rows: models } = await db.execute<{ id: string }>(sql`
    SELECT id FROM models WHERE code = ${model}`)
  const modelId = models[0]?.id
  if (!modelId) throw new Error(`нет модели ${model}`)
  const snapshot = await snapshotOf(db, modelId, null)
  if (!snapshot) throw new Error(`у модели ${model} нет снимка`)
  const entries = listFile ? parseCopyList(await readFile(listFile, 'utf8')) : []
  const metaRead = listFile ? await readCopyListMeta(listFile) : { meta: null, corrupt: false }
  const list = new CopyList(entries)
  const decisions = new Map(
    (await originalStates(db, modelId, { members: true }))
      .filter((state) => state.kind === 'revision')
      .map((state) => [state.id, state]),
  )
  const roots = new Map<string, ReleaseRoot>()
  const known = new Set<string>()
  for (const row of await rowsOf(db, snapshot)) {
    const relative = sourcePath(row.path, snapshot.rootPath).relative
    const name = relative.split('/')[0] ?? ''
    const root = roots.get(name) ?? {
      root: name,
      files: 0,
      members: 0,
      snapshot_bytes: 0,
      copy_bytes: 0,
      blockers: {},
      ready: false,
      rows: [],
      outside: [],
    }
    roots.set(name, root)
    const { outcome, reason } = classify(row)
    const size = Number(row.size)
    const copied = row.member ? null : list.fileOf(row.path)
    if (copied) known.add(relativePath(copied.localPath))
    if (row.member) root.members += 1
    else {
      root.files += 1
      root.snapshot_bytes += size
      if (copied?.bytesPresent) root.copy_bytes += copied.size
    }
    const decision = decisions.get(row.revision_id)
    if (!decision?.decided) bump(root.blockers, blockerOf(row, outcome, reason, decision))
    if (copied?.bytesPresent && copied.size !== size) {
      bump(root.blockers, 'размер в копии не совпадает со снимком')
    }
    root.rows.push({
      path: relative,
      size,
      member: row.member,
      outcome,
      reason,
      item: row.item,
      source_sha256: row.source_sha,
      master: row.master_sha ? { sha256: row.master_sha, state: row.master_state ?? '' } : null,
      copy: copied ? (copied.bytesPresent ? 'bytes' : 'placeholder') : null,
    })
  }
  const hasExplicitUnlistedDir = entries.some((entry) => entry.is_dir && entry.listed === false)
  // The copy may hold what the snapshot does not know (a file the client brought later):
  // the import has not checked it, so the root waits.
  for (const root of roots.values()) {
    const rootLocal = apiToLocalPath(`${snapshot.rootPath}/${root.root}`)
    const prefix = `${rootLocal}/`
    for (const entry of entries) {
      const path = relativePath(entry.path)
      if (entry.is_dir) {
        if (entry.listed === false && (path === rootLocal || path.startsWith(prefix))) {
          bump(root.blockers, 'не перечисленная папка в копии')
        }
        continue
      }
      if (!path.startsWith(prefix) || known.has(path)) continue
      if (!entry.bytes_present) continue
      root.outside.push({ path, size: entry.size })
      root.copy_bytes += entry.size
      bump(root.blockers, 'в копии, но не в снимке')
    }
    if (!listFile) bump(root.blockers, 'нет списка копии')
    if (metaRead.corrupt) bump(root.blockers, 'битая мета списка копии')
    if (metaRead.meta) {
      if (metaRead.meta.errors > 0) bump(root.blockers, 'ошибки обхода копии')
      if (metaRead.meta.client_running) {
        bump(root.blockers, 'клиент Я.Диска был запущен при обходе')
      }
      if (metaRead.meta.dirs_not_listed > 0 && !hasExplicitUnlistedDir) {
        bump(root.blockers, 'не все папки копии перечислены')
      }
    }
    root.ready = Object.keys(root.blockers).length === 0
  }
  const ordered = [...roots.values()].sort((a, b) => a.root.localeCompare(b.root, 'ru'))
  return {
    model,
    snapshot: snapshot.workKey,
    source: snapshot.sourceLabel,
    copy_list: listFile,
    copy_list_meta: metaRead.meta,
    roots: ordered,
    ready_bytes: ordered.filter((r) => r.ready).reduce((sum, r) => sum + r.copy_bytes, 0),
  }
}

const OUTCOME: Record<Outcome, string> = {
  accepted: 'принят',
  alias: 'алиас принятых байтов',
  rejected: 'отклонён',
  archive: 'архив (по участникам)',
  blocked: 'заблокирован',
  waiting: 'ожидает',
  not_media: 'не медиа',
  not_content: 'не контент',
  unexplained: 'НЕОБЪЯСНЁН',
}

const COPY: Record<'bytes' | 'placeholder', string> = { bytes: 'байты', placeholder: 'заглушка' }

const short = (sha: string | null) => (sha ? `\`${sha.slice(0, 12)}…\`` : '—')
const cell = (text: string) => text.replaceAll('|', '\\|')

function fileLine(file: ReleaseFile): string {
  const master = file.master ? `${short(file.master.sha256)} ${file.master.state}` : '—'
  const outcome = file.reason ? `${OUTCOME[file.outcome]} (${file.reason})` : OUTCOME[file.outcome]
  return `| ${cell(file.member ? `↳ ${file.path}` : file.path)} | ${formatBytes(file.size)} | ${
    file.member ? 'в архиве' : file.copy ? COPY[file.copy] : 'нет в списке'
  } | ${outcome} | ${file.item ?? '—'} | ${short(file.source_sha256)} | ${master} |`
}

/** The report as Markdown, for the owner's session; out of git (it names real files). */
export function releaseMarkdown(report: ReleaseReport): string {
  const ready = report.roots.filter((root) => root.ready)
  const waiting = report.roots.filter((root) => !root.ready)
  const smallest = [...ready]
    .filter((root) => root.copy_bytes > 0)
    .sort((a, b) => a.copy_bytes - b.copy_bytes)[0]
  const listStamp = report.copy_list_meta?.finished_at
    ? ` (от ${report.copy_list_meta.finished_at})`
    : ''
  const metaNotes: string[] = []
  if (report.copy_list_meta) {
    if (report.copy_list_meta.errors > 0) {
      metaNotes.push(`ошибок обхода: ${report.copy_list_meta.errors}`)
    }
    if (report.copy_list_meta.dirs_not_listed > 0) {
      metaNotes.push(`не перечислено папок: ${report.copy_list_meta.dirs_not_listed}`)
    }
    if (report.copy_list_meta.client_running) metaNotes.push('клиент Я.Диска был запущен')
  }
  return [
    `# Можно освобождать: ${report.model}`,
    '',
    `- Снимок: \`${report.snapshot}\` (${report.source}); список копии: ${report.copy_list ? `\`${report.copy_list}\`${listStamp}` : 'нет'}${metaNotes.length > 0 ? ` — ${metaNotes.join(', ')}` : ''}`,
    `- Готовы к снятию закрепления: ${ready.length} из ${report.roots.length} корней; ожидаемый выигрыш — ${formatBytes(report.ready_bytes)} (байты в копии)`,
    '- Как: по файлу, задачей Windows `ContentOps-Originals-YDisk` — то, что отдаёт маршрут оригиналов (SPEC §9.4, §12.2).',
    '  Ничего не удаляется ни в копии, ни в облаке: исходник остаётся в облаке, мастер — у нас.',
    '  Выигрыш засчитывается по замеру свободного места; два следующих полных обхода не должны',
    '  отметить пропажу файлов.',
    `- Первое снятие — на одной маленькой проверенной папке${smallest ? `: «${smallest.root}», ${formatBytes(smallest.copy_bytes)}` : ''}.`,
    '',
    '## Корни',
    '',
    '| Корень | Файлов | В снимке | Байты в копии | Можно освобождать | Почему нет |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.roots.map(
      (root) =>
        `| ${cell(root.root)} | ${root.files}${root.members ? ` + ${root.members} в архивах` : ''} | ${formatBytes(root.snapshot_bytes)} | ${formatBytes(root.copy_bytes)} | ${root.ready ? 'да' : 'нет'} | ${
          Object.entries(root.blockers)
            .sort(([, a], [, b]) => b - a)
            .map(([reason, n]) => `${cell(reason)}: ${n}`)
            .join('; ') || '—'
        } |`,
    ),
    '',
    ...ready.flatMap((root) => [
      `## ${root.root} — можно освобождать, ${formatBytes(root.copy_bytes)}`,
      '',
      '| Файл | Размер | В копии | Исход | Объект | SHA-256 источника | Мастер |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...root.rows.map(fileLine),
      '',
    ]),
    ...(waiting.length === 0
      ? []
      : [
          '## Пока нельзя',
          '',
          ...waiting.flatMap((root) => [
            `- **${root.root}** — ${Object.entries(root.blockers)
              .sort(([, a], [, b]) => b - a)
              .map(([reason, n]) => `${reason}: ${n}`)
              .join('; ')}`,
            ...root.outside
              .slice(0, 20)
              .map((file) => `  - вне снимка: ${file.path}, ${formatBytes(file.size)}`),
          ]),
          '',
        ]),
  ].join('\n')
}
