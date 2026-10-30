import type { ItemTypeCode } from './types.ts'

/**
 * Loose ID forms (SPEC §4.1, naming §5): `ppv73`, `PPV 73`, `[PPV-073]`, 1–6 digits. File
 * names and vault albums are read with the Latin type only; `spoken` adds the words of speech
 * (`ппв-73`, `секстинг 10`, `S10`) for texts people wrote. The model is never guessed here:
 * the resolver of the server takes it explicitly.
 */

const LATIN: Record<string, ItemTypeCode> = {
  ppv: 'PPV',
  set: 'SET',
  sxt: 'SXT',
  cus: 'CUS',
  cst: 'CUS',
  fyp: 'FYP',
  life: 'LIFE',
  raw: 'RAW',
  prm: 'PRM',
}

const SPOKEN: readonly [RegExp, ItemTypeCode][] = [
  [/^(ппв|пвп)$/, 'PPV'],
  [/^сет$/, 'SET'],
  [/^(s|sexting|секст|секстинг)$/, 'SXT'],
  [/^(кастом|кас)$/, 'CUS'],
  [/^(фуп|фап)$/, 'FYP'],
  [/^лайф$/, 'LIFE'],
  [/^(съёмка|съемка|сырьё|сырье)$/, 'RAW'],
  [/^промо$/, 'PRM'],
]

const MENTION = /(?<![\p{L}\d])\[?\s*(\p{L}+)\s*[-_ ]?\s*(\d{1,7})\s*\]?(?![\p{L}\d])/gu

export interface IdMention {
  type: ItemTypeCode
  number: number
  raw: string
  index: number
}

export function findIdMentions(text: string, options: { spoken?: boolean } = {}): IdMention[] {
  const out: IdMention[] = []
  MENTION.lastIndex = 0
  for (let m = MENTION.exec(text); m !== null; m = MENTION.exec(text)) {
    const word = (m[1] ?? '').toLowerCase()
    const digits = m[2] ?? ''
    if (digits.length > 6) continue
    let type: ItemTypeCode | null = LATIN[word] ?? null
    if (!type && options.spoken) type = SPOKEN.find(([p]) => p.test(word))?.[1] ?? null
    if (!type) continue
    const number = Number(digits)
    if (number < 1) continue
    out.push({ type, number, raw: m[0].trim(), index: m.index })
  }
  return out
}
