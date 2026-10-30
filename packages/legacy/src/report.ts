import type { LegacyImportPlan, NumberClaimPlan } from './plan.ts'

/**
 * The dry-run report as it is kept (PLAN этап 3 «Сухой прогон (`import plan`)»): the plan
 * without the parsed entries — those are the claims the metadata pass writes. It lands on the
 * work row as JSON; `planMarkdown` makes the human-readable export on command. The export
 * holds real names of the disk: it stays out of git (repo AGENTS.md).
 */
export type LegacyPlanReport = Omit<LegacyImportPlan, 'entries'> & {
  mode: 'plan' | 'parse'
  model: string
  /** The snapshot work `scan:freeze:<date>` the listing comes from. */
  snapshot: { work_id: string; work_key: string; source: string; finished_at: string }
  registry_rows: number
  vault_albums: number
}

export function summarizePlan(
  plan: LegacyImportPlan,
  meta: Omit<LegacyPlanReport, keyof Omit<LegacyImportPlan, 'entries'>>,
): LegacyPlanReport {
  const { entries: _entries, ...rest } = plan
  return { ...meta, ...rest }
}

const cell = (value: unknown): string =>
  String(value ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')

function table(head: readonly string[], rows: readonly (readonly unknown[])[]): string[] {
  if (rows.length === 0) return ['нет', '']
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
  ]
}

const DECISION: Record<NumberClaimPlan['decision'], string> = {
  keep: 'оставить',
  renumber: 'новый номер',
  typo: 'опечатка',
  unclear: 'неясно',
}

const id = (type: string, n: number | null) =>
  n === null ? '—' : `${type}-${String(n).padStart(type === 'FYP' || type === 'RAW' ? 4 : 3, '0')}`

function sourceOf(claim: NumberClaimPlan): string {
  const s = claim.source
  if (s.kind === 'path') return s.path
  if (s.kind === 'registry') return `реестр, строка ${s.row}: ${s.folder}`
  return `${s.source}: ${s.text}`
}

const bytes = (n: number | null) => (n === null ? '—' : `${(n / 1024 ** 3).toFixed(2)} ГБ`)

function accountText(account: { kind: string; index?: number }): string {
  if (account.kind === 'index') return `страница ${account.index}`
  return account.kind === 'all' ? 'все страницы Fansly' : 'неизвестна'
}

/** The dry run as Markdown, section by section in the order of PLAN этап 3. */
export function planMarkdown(report: LegacyPlanReport): string {
  const out: string[] = [
    `# Сухой прогон импорта: ${report.model}`,
    '',
    `- Снимок: \`${report.snapshot.work_key}\` (${report.snapshot.source}), готов ${report.snapshot.finished_at}`,
    `- Правила разбора: \`${report.parserVersion}\``,
    `- Записей: ${report.coverage.entries} (файлов ${report.coverage.files}, папок ${report.coverage.dirs}); ` +
      `строк реестра ${report.registry_rows}; альбомов vault ${report.vault_albums}`,
    '',
    '## Номера: резерв по типам',
    '',
    ...table(
      ['Тип', 'Наибольший заявленный', 'Счётчик сейчас', 'Следующий номер', 'Дыры'],
      report.reserve.map((r) => [
        r.type,
        r.maxClaimed,
        r.current,
        r.next,
        r.holes.length === 0
          ? '—'
          : `${r.holes.length}: ${r.holes.slice(0, 30).join(', ')}${r.holes.length > 30 ? ' …' : ''}`,
      ]),
    ),
    '## Коллизии',
    '',
  ]
  if (report.collisions.length === 0) out.push('нет', '')
  for (const c of report.collisions) {
    out.push(
      `### ${id(c.type, c.number)}: ${c.resolution === 'earliest_keeps' ? 'номер у самой ранней' : 'решает человек'}`,
      '',
      ...table(
        ['Папка', 'Дата релиза', 'Решение', 'Номер', 'Ожидаемый новый номер'],
        c.units.map((u) => [
          u.name,
          u.releaseDate,
          DECISION[u.decision],
          id(c.type, u.assignedNumber),
          id(c.type, u.projectedNumber),
        ]),
      ),
    )
  }
  out.push(
    '## Опечатки номеров',
    '',
    ...table(
      ['Папка', 'В имени', 'В реестре', 'Строка реестра'],
      report.typos.map((t) => [
        t.name,
        id(t.type, t.claimedNumber),
        id(t.type, t.registryNumber),
        t.registryRow,
      ]),
    ),
    '## SXT-010/011',
    '',
    ...table(
      ['Номер', 'Итог', 'Улики'],
      report.sextings.map((s) => [
        id('SXT', s.number),
        s.status === 'reserve' ? 'резерв' : 'дыра',
        s.evidence.map((e) => `${e.source}: ${e.text}`).join('; '),
      ]),
    ),
    '## Заявки номеров',
    '',
    ...table(
      ['Номер', 'Источник', 'Решение', 'Назначен', 'Причина'],
      report.numberClaims.map((c) => [
        id(c.type, c.claimedNumber),
        sourceOf(c),
        DECISION[c.decision],
        id(c.type, c.assignedNumber ?? c.projectedNumber),
        c.reason,
      ]),
    ),
    '## Метки старых имён: подтверждает КМ',
    '',
    ...table(
      ['Метка', 'По правилу', 'Сколько', 'С датой', 'Без даты', 'Примеры'],
      report.labels.map((l) => [
        l.label,
        accountText(l.proposedAccount),
        l.count,
        l.withDate,
        l.withoutDate,
        l.examples.join('; '),
      ]),
    ),
    '## Неразобранные имена',
    '',
    ...table(
      ['Путь', 'Фрагменты'],
      report.unparsed.map((u) => [u.path, u.fragments.join(', ')]),
    ),
    '## «Старый формат»',
    '',
    ...table(
      ['Папка', 'Файлов', 'Папок', 'Объём', 'Старые номера (алиасы)', 'Меток', 'Неразобрано'],
      report.oldFormat.map((f) => [
        f.folder,
        f.files,
        f.dirs,
        bytes(f.bytes),
        f.numberAliases.map((a) => id(a.type, a.number)).join(', '),
        f.labels,
        f.unknownFragments,
      ]),
    ),
    '## SMM: пак подрядчику или съёмка вендора — отметить',
    '',
    ...table(
      ['Папка', 'Канал', 'Файлов', 'Объём', 'Первая заливка', 'Последняя'],
      report.smmFolders.map((f) => [
        f.path,
        f.channel,
        f.files,
        bytes(f.bytes),
        f.firstUpload,
        f.lastUpload,
      ]),
    ),
    '## Архивы',
    '',
    ...table(
      ['Архив', 'Объём', 'Чужая модель', 'Участников в оглавлении', 'Неполный'],
      report.archives.map((a) => [
        a.path,
        bytes(a.bytes),
        a.foreignModel,
        a.entriesListed,
        a.incomplete ? 'да' : 'нет',
      ]),
    ),
    '## Неполный вход',
    '',
    ...(report.incompleteInputs.length === 0
      ? ['нет', '']
      : [...report.incompleteInputs.map((p) => `- ${p}`), '']),
    '## Точные дубли',
    '',
    `Групп ${report.duplicates.length}, лишних копий ${report.duplicates.reduce((n, d) => n + d.paths.length - 1, 0)}.`,
    '',
    ...table(
      ['Хэш', 'Размер', 'Пути'],
      report.duplicates
        .slice(0, 100)
        .map((d) => [`${d.hashKind}:${d.hash.slice(0, 12)}`, d.size, d.paths.join('; ')]),
    ),
    '## Покрытие',
    '',
    `- С заявкой кроме «неизвестно»: ${report.coverage.withClaim} из ${report.coverage.entries}`,
    `- Без неразобранных фрагментов: ${report.coverage.withoutUnknown}`,
    `- Неразобранных фрагментов: ${report.coverage.unknownFragments} (${
      Object.entries(report.coverage.unknownByRoot)
        .map(([root, n]) => `${root}: ${n}`)
        .join(', ') || 'нет'
    })`,
    '',
  )
  return out.join('\n')
}
