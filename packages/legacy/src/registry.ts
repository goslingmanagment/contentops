import { parseLegacyName } from './name.ts'
import { nfc, PARSER_VERSION, shortHash } from './text.ts'
import type { ClaimOf, LegacyDate, RegistryRowPayload, RegistryTags } from './types.ts'

/**
 * The PPV registry (legacy §4): a Google sheet, one row per PPV folder, columns «название
 * папки · Тип контента · Действия · Атрибуты · Настроение · кол-во едениц контента ·
 * комментарий». Accepts the export as CSV, TSV, a Markdown table or ready rows.
 */

export type RegistryClaim = ClaimOf<'registry_row'>

function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === separator) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function parseMarkdown(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
}

/** Text of the export → rows of cells. */
export function registryRows(text: string): string[][] {
  const clean = nfc(text).replace(/^﻿/, '')
  const firstLine = clean.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  if (firstLine.trim().startsWith('|')) return parseMarkdown(clean)
  if (firstLine.includes('\t')) return parseCsv(clean, '\t')
  return parseCsv(clean, ',')
}

interface Columns {
  folder: number
  type: number
  actions: number
  attributes: number
  mood: number
  units: number
  comment: number
}

const POSITIONAL: Columns = {
  folder: 0,
  type: 1,
  actions: 2,
  attributes: 3,
  mood: 4,
  units: 5,
  comment: 6,
}

function columnsOf(header: string[]): Columns | null {
  const find = (pattern: RegExp) => header.findIndex((cell) => pattern.test(cell))
  const folder = find(/папк/i)
  if (folder < 0) return null
  return {
    folder,
    type: find(/тип/i),
    actions: find(/действ/i),
    attributes: find(/атрибут/i),
    mood: find(/настроен/i),
    units: find(/кол-?во|един/i),
    comment: find(/коммент/i),
  }
}

/** Compound tags of the registry that must not be split by spaces. */
const PHRASES = [
  'get ready with me',
  'dressing up to tease',
  'licking a glass',
  'close up',
  'close ap',
  'butt plug',
  'glass dildo',
  'slow mo',
  'nipple play',
  'nipple game',
  'booty shaking',
  'shake booty',
  'shaking boobs',
  'deep throat',
  'boob massage',
  'tit massage',
  'massage tits',
  'foot fetish',
  '2 fingers',
  '2 finger',
  'knee socks',
  'white socks',
  'lace panties',
  'washing machine',
  'short skirt',
  'mesh tights',
  'red dress',
  'pink skirt',
  'red lingerie',
]

/** «Lingerie naked close up» → `lingerie`, `naked`, `close up`; commas split first. */
export function splitTags(cell: string): string[] {
  const out: string[] = []
  for (const part of cell.split(/[,;]/)) {
    let rest = ` ${part.toLowerCase().replace(/\s+/g, ' ').trim()} `
    for (const phrase of PHRASES) {
      const needle = ` ${phrase} `
      while (rest.includes(needle)) {
        out.push(phrase)
        rest = rest.replace(needle, ' \u0000 ')
      }
    }
    for (const word of rest.split(' ')) if (word !== '' && word !== '\u0000') out.push(word)
  }
  return [...new Set(out)]
}

function commentDuration(comment: string): number | null {
  const clock = /(\d{1,2})[:.](\d{2})\s*(?:мин|$|\.|\s)/u.exec(comment)
  if (clock && Number(clock[2]) < 60) return Number(clock[1]) * 60 + Number(clock[2])
  const minutes = /(\d{1,3})\s*(?:мин|минут)/u.exec(comment)
  return minutes ? Number(minutes[1]) * 60 : null
}

function rowPayload(row: number, cells: string[], col: Columns): RegistryRowPayload | null {
  const cell = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '')
  const folder = cell(col.folder)
  if (folder === '') return null
  const claims = parseLegacyName(folder, { isDir: true })
  const number = claims.find((c) => c.kind === 'number' && c.payload.type === 'PPV')
  const title = claims.find((c) => c.kind === 'title')
  const date = claims.find((c) => c.kind === 'date')
  const duration = claims.find((c) => c.kind === 'duration')
  const kindCell = cell(col.type).toLowerCase()
  const comment = cell(col.comment)
  const units = /^\d+$/.test(cell(col.units)) ? Number(cell(col.units)) : null
  const tags: RegistryTags = {
    actions: splitTags(cell(col.actions)),
    attributes: splitTags(cell(col.attributes)),
    mood: splitTags(cell(col.mood)),
  }
  const customNote = /кастом\s*\(([^)]*)\)/iu.exec(comment)?.[1]?.trim() ?? null
  const folderDate: LegacyDate | null = date?.kind === 'date' ? date.payload.date : null
  return {
    row,
    folder,
    type: 'PPV',
    number: number?.kind === 'number' ? number.payload.number : null,
    title_en: title?.kind === 'title' ? title.payload.text : null,
    ppv_kind: /одиноч/.test(kindCell) ? 'dm' : /бандл|bundle/.test(kindCell) ? 'bundle' : null,
    tags,
    units,
    comment: comment === '' ? null : comment,
    from_custom: /кастом/iu.test(comment),
    custom_note: customNote === '' ? null : customNote,
    folder_date: folderDate,
    folder_date_unset: date?.kind === 'date' ? date.payload.unset : false,
    duration_seconds:
      commentDuration(comment) ?? (duration?.kind === 'duration' ? duration.payload.seconds : null),
    posted: /(?<![\p{L}])(posted|used)(?![\p{L}])/iu.test(comment),
    voice: /англ/iu.test(comment) ? 'en' : /русск/iu.test(comment) ? 'ru' : null,
  }
}

/**
 * Registry export → one `registry_row` claim per data row. The claim key is the folder cell:
 * a re-export with the same rows gives the same keys.
 */
export function parsePpvRegistry(input: string | readonly (readonly string[])[]): RegistryClaim[] {
  const rows = typeof input === 'string' ? registryRows(input) : input.map((r) => [...r])
  const headerAt = rows.findIndex((r) => columnsOf(r) !== null)
  const columns = headerAt >= 0 ? (columnsOf(rows[headerAt] ?? []) ?? POSITIONAL) : POSITIONAL
  const data = rows.slice(headerAt + 1)
  const seen = new Map<string, number>()
  const out: RegistryClaim[] = []
  data.forEach((cells, i) => {
    const payload = rowPayload(i + 1, cells, columns)
    if (!payload) return
    const base = `registry:${shortHash(nfc(payload.folder))}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out.push({
      kind: 'registry_row',
      raw_fragment: cells.map((c) => c.trim()).join(' | '),
      claim_key: n === 1 ? base : `${base}:${n}`,
      parser_version: PARSER_VERSION,
      payload,
    })
  })
  return out
}
