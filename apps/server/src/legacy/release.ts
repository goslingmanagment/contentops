import { readFile } from 'node:fs/promises'
import { formatBytes } from '@contentops/contracts/format'
import type { Db } from '@contentops/db'
import { apiToLocalPath, CopyList, parseCopyList, relativePath } from '@contentops/legacy'
import { sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { classify, type Outcome, rowsOf } from './reconcile'
import { snapshotOf } from './snapshot'

/**
 * «Можно освобождать» (PLAN этап 7, 9а; SPEC §12.2): the roots of the old disk whose local copy
 * may be unpinned in the Я.Диск client — every file of the root went into the import and has a
 * green outcome of the reconciliation (accepted, an alias of accepted bytes, rejected by a person
 * with a reason, an archive accounted by its members, not media), every accepted file has its
 * master on our disk, and the copy holds nothing the snapshot does not know. For each such root
 * the files with their sizes, the bytes the copy holds (the gain to expect), the object, the
 * SHA-256 of the source bytes the import checked against the snapshot's MD5, and the master.
 *
 * It only reads: the database and the Windows list of the copy (`LEGACY_COPY_LIST`). Unpinning is
 * the owner's approved session in the client, nothing is deleted, the cloud keeps the source.
 * The report names real files: by the operator's command only, never into git.
 */

/** Outcomes that leave nothing for the import to take from the copy. */
const DONE: ReadonlySet<Outcome> = new Set([
  'accepted',
  'alias',
  'rejected',
  'archive',
  'not_media',
])

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

export interface ReleaseReport {
  model: string
  snapshot: string
  source: string
  copy_list: string | null
  roots: ReleaseRoot[]
  ready_bytes: number
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
  const list = new CopyList(entries)
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
    if (!DONE.has(outcome)) bump(root.blockers, reason ? `${outcome}:${reason}` : outcome)
    const taken = outcome === 'accepted' || outcome === 'alias'
    if (taken && row.master_state !== 'present') bump(root.blockers, 'мастер не на месте')
    if (taken && !row.source_sha) bump(root.blockers, 'байты источника не проверены')
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
  // The copy may hold what the snapshot does not know (a file the client brought later):
  // the import has not checked it, so the root waits.
  for (const root of roots.values()) {
    const prefix = `${apiToLocalPath(`${snapshot.rootPath}/${root.root}`)}/`
    for (const entry of entries) {
      const path = relativePath(entry.path)
      if (entry.is_dir || !path.startsWith(prefix) || known.has(path)) continue
      if (!entry.bytes_present) continue
      root.outside.push({ path, size: entry.size })
      root.copy_bytes += entry.size
      bump(root.blockers, 'в копии, но не в снимке')
    }
    if (!listFile) bump(root.blockers, 'нет списка копии')
    root.ready = Object.keys(root.blockers).length === 0
  }
  const ordered = [...roots.values()].sort((a, b) => a.root.localeCompare(b.root, 'ru'))
  return {
    model,
    snapshot: snapshot.workKey,
    source: snapshot.sourceLabel,
    copy_list: listFile,
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
  return [
    `# Можно освобождать: ${report.model}`,
    '',
    `- Снимок: \`${report.snapshot}\` (${report.source}); список копии: ${report.copy_list ? `\`${report.copy_list}\`` : 'нет'}`,
    `- Готовы к снятию закрепления: ${ready.length} из ${report.roots.length} корней; ожидаемый выигрыш — ${formatBytes(report.ready_bytes)} (байты в копии)`,
    '- Как: «Освободить место» у корня в клиенте Я.Диска на одобренном владельцем сеансе (SPEC §12.2).',
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
