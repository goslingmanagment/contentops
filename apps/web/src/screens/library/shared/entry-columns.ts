import {
  type Account,
  type CatalogEntry,
  FAN_NAME_LABEL,
  formatDate,
  formatDuration,
  formatNumber,
  type ItemType,
  type LocalDate,
  type PageSummaryEntry,
  plural,
  RAW_PURPOSE_LABEL,
} from '@contentops/contracts'
import { compositionLabel } from '@/lib/words'
import { placedPagesText } from '@/objects/placement-text'

/**
 * Три серые колонки строки списка (DESIGN §4.2): длительность или кадры, дата прихода и
 * ответ, который важен для типа: где залито, а у кастома — сделан ли из него PPV, у
 * сырья — назначение.
 */

function counted(count: number, forms: readonly [string, string, string]): string {
  return `${formatNumber(count)} ${plural(count, forms)}`
}

const files = (entry: CatalogEntry) => (entry.photo_count ?? 0) + (entry.video_count ?? 0)

const LENGTH: Record<ItemType, (entry: CatalogEntry) => string> = {
  ppv: (entry) => (entry.duration_s === null ? '—' : formatDuration(entry.duration_s)),
  fyp: (entry) => (entry.duration_s === null ? '—' : formatDuration(entry.duration_s)),
  custom: (entry) =>
    entry.duration_s === null ? (compositionLabel(entry) ?? '—') : formatDuration(entry.duration_s),
  set: (entry) => counted(entry.photo_count ?? 0, ['кадр', 'кадра', 'кадров']),
  sexting: (entry) => counted(files(entry), ['файл', 'файла', 'файлов']),
  // Фото и видео вместе — «18 файлов», как на плитке (§4.2): «16 фото · 2 видео» в колонку 80
  // не входит, целиком состав — в мета-строке объекта и в панели.
  life: (entry) => compositionLabel(entry) ?? '—',
  raw: (entry) => counted(files(entry), ['файл', 'файла', 'файлов']),
  promo: (entry) => `${formatNumber(entry.video_count ?? 0)} видео`,
}

type AnswerColumn = (
  entry: CatalogEntry,
  accounts: readonly Account[],
  summaries: readonly PageSummaryEntry[] | undefined,
) => string

const placed: AnswerColumn = (_entry, accounts, summaries) => placedPagesText(accounts, summaries)

const ANSWER: Record<ItemType, AnswerColumn> = {
  ppv: placed,
  fyp: placed,
  custom: (entry) =>
    entry.ppv_made_as
      ? `в ${entry.ppv_made_as}`
      : entry.fan_name
        ? FAN_NAME_LABEL[entry.fan_name]
        : '',
  set: placed,
  sexting: placed,
  life: placed,
  raw: (entry) => (entry.raw_purpose ? `назначение: ${RAW_PURPOSE_LABEL[entry.raw_purpose]}` : ''),
  promo: () => '',
}

export function entryColumns(
  entry: CatalogEntry,
  accounts: readonly Account[],
  summaries: readonly PageSummaryEntry[] | undefined,
  today: LocalDate,
): readonly [string, string, string] {
  return [
    LENGTH[entry.type](entry),
    formatDate(entry.arrived_on, today),
    ANSWER[entry.type](entry, accounts, summaries),
  ]
}
