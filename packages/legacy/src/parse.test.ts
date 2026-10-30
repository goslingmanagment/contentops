import { describe, expect, it } from 'vitest'
import { FIXTURE_REGISTRY } from './fixture.ts'
import { findIdMentions } from './ids.ts'
import { apiToLocalPath, LocalPathIndex, localCopyPath } from './local-path.ts'
import { parseLegacyName } from './name.ts'
import { parseLegacyPath } from './path.ts'
import { parsePpvRegistry, registryRows, splitTags } from './registry.ts'
import { PARSER_VERSION } from './text.ts'

const file = (name: string) => parseLegacyName(name, { isDir: false })
const kinds = (name: string) => file(name).map((c) => c.kind)

describe('names', () => {
  it('is deterministic: same name and version — same claims and keys', () => {
    const name = 'used3_10.07.26_used2_09.07.26_FYP_2_14.06.25.MOV'
    expect(file(name)).toEqual(file(name))
    expect(file(name).every((c) => c.parser_version === PARSER_VERSION)).toBe(true)
    expect(new Set(file(name).map((c) => c.claim_key)).size).toBe(file(name).length)
  })

  it('keeps what it does not understand as `unknown` with the raw fragment', () => {
    expect(file('used_all_1_3_2.09.MOV')).toContainEqual(
      expect.objectContaining({ kind: 'unknown', raw_fragment: '1_3' }),
    )
    expect(file('7bl.mov')).toEqual([
      expect.objectContaining({ kind: 'unknown', raw_fragment: '7bl' }),
    ])
    expect(file('used2_2_18.08_used3_2_12.08_0233.mov').at(-1)).toMatchObject({
      kind: 'unknown',
      raw_fragment: '0233',
      payload: { reason: 'number' },
    })
  })

  it('reads a label glued to a nick and a typo date `DD_MM.YY`', () => {
    expect(file('PPV_Масло_3мин_05.04.25_кастом_orionUSED1.MOV')).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        payload: expect.objectContaining({ label: 'used1' }),
      }),
    )
    expect(file('used3_03_01.26.mov')[0]).toMatchObject({
      kind: 'used',
      payload: { label: 'used3', date: { iso: '2026-01-03' }, notes: ['date_typo'] },
    })
  })

  it('a bare `used` inside a word is not a label', () => {
    expect(kinds('focused_look.mov')).toEqual(['title'])
  })

  it('a slug with a number-like word is not an ID', () => {
    const claims = parseLegacyName('[PPV-002]_3fingers_dildo_10min_10.04.2025', { isDir: true })
    expect(claims.filter((c) => c.kind === 'number')).toHaveLength(1)
    expect(file('PPV_3пальца_10мин.MOV').some((c) => c.kind === 'number')).toBe(false)
  })

  it('loose Latin IDs inside names are aliases, not reservations', () => {
    expect(file('promo ppv73.mov')).toContainEqual(
      expect.objectContaining({
        kind: 'number',
        payload: { type: 'PPV', number: 73, form: 'loose', reserves: false },
      }),
    )
  })

  it('structural folders give nothing and nothing unknown', () => {
    for (const name of ['1. PPV', '9. SMM', 'Старый формат', 'Twitter', 'New Folder With Items']) {
      expect(parseLegacyName(name, { isDir: true })).toEqual([])
    }
  })
})

describe('ID forms (SPEC §4.1)', () => {
  it('reads `ppv73`, `PPV 73`, `[PPV-073]`, 1–6 digits; Cyrillic only as speech', () => {
    for (const text of ['ppv73', 'PPV 73', '[PPV-073]', 'PPV_073']) {
      expect(findIdMentions(text)).toEqual([expect.objectContaining({ type: 'PPV', number: 73 })])
    }
    expect(findIdMentions('ппв-73')).toEqual([])
    expect(findIdMentions('ппв-73', { spoken: true })).toEqual([
      expect.objectContaining({ type: 'PPV', number: 73 }),
    ])
    expect(findIdMentions('PPV-123456')[0]?.number).toBe(123456)
    expect(findIdMentions('PPV-1234567')).toEqual([])
    expect(findIdMentions('S10 атлас', { spoken: true })).toEqual([
      expect.objectContaining({ type: 'SXT', number: 10 }),
    ])
  })
})

describe('paths', () => {
  it('accepts `disk:/` and NFD, keeps trailing spaces of parts', () => {
    const nfd = 'disk:/3. Customs/13:03 Йога .mov'.normalize('NFD')
    const parsed = parseLegacyPath(nfd, { isDir: false })
    expect(parsed.path).toBe('3. Customs/13:03 Йога .mov')
    expect(parsed.claims).toContainEqual(
      expect.objectContaining({ kind: 'title', payload: { text: 'Йога', lang: 'ru' } }),
    )
  })
})

describe('local copy path (SPEC §6.3)', () => {
  it('replaces `:` and a trailing space of any part with `-`', () => {
    expect(apiToLocalPath('disk:/3. Customs/13:03 Орион .mov')).toBe('3. Customs/13-03 Орион .mov')
    expect(apiToLocalPath('disk:/9. SMM/YT/Mirko/декабрь - ASMR - 6 видео /1 video/a.mov')).toBe(
      '9. SMM/YT/Mirko/декабрь - ASMR - 6 видео-/1 video/a.mov',
    )
    expect(localCopyPath('/mnt/ydisk/', 'disk:/BG/13:08 у окна.mov')).toBe(
      '/mnt/ydisk/BG/13-08 у окна.mov',
    )
  })

  it('maps back through the listing, ambiguity included', () => {
    const index = new LocalPathIndex([
      'disk:/3. Customs/13:03 tail.mov',
      'disk:/3. Customs/13-03 tail.mov',
      'disk:/A /b.mov',
    ])
    expect(index.apiPathsOf('/mnt/ydisk/3. Customs/13-03 tail.mov', '/mnt/ydisk')).toEqual([
      '3. Customs/13-03 tail.mov',
      '3. Customs/13:03 tail.mov',
    ])
    expect(index.apiPathsOf('A-\\b.mov')).toEqual(['A /b.mov'])
    expect(index.apiPathsOf('nothing')).toEqual([])
  })
})

describe('PPV registry (legacy §4)', () => {
  const rows = parsePpvRegistry(FIXTURE_REGISTRY)

  it('one claim per data row, with number, kind, tag groups and comment facts', () => {
    expect(rows).toHaveLength(12)
    expect(rows[0]).toMatchObject({
      kind: 'registry_row',
      parser_version: PARSER_VERSION,
      payload: {
        row: 1,
        number: 1,
        title_en: 'lotus pose',
        ppv_kind: 'dm',
        tags: {
          actions: ['yoga', 'stretching'],
          attributes: ['close up', 'leggings'],
          mood: ['calm'],
        },
        units: 1,
        from_custom: true,
        custom_note: 'Fan_Orion',
        folder_date: { iso: '2025-03-03' },
        duration_seconds: 420,
      },
    })
    expect(rows.find((r) => r.payload.folder.includes('paint_body'))?.payload).toMatchObject({
      ppv_kind: 'bundle',
      duration_seconds: 602,
      voice: 'en',
    })
    expect(rows.find((r) => r.payload.number === 24)?.payload.posted).toBe(true)
    expect(rows.find((r) => r.payload.number === 66)?.payload).toMatchObject({
      folder_date: null,
      folder_date_unset: true,
      from_custom: true,
      custom_note: null,
    })
    expect(rows.find((r) => r.payload.number === 69)?.payload.tags).toEqual({
      actions: [],
      attributes: [],
      mood: [],
    })
  })

  it('reads CSV and TSV exports the same way, keys follow the folder cell', () => {
    const md = registryRows(FIXTURE_REGISTRY)
    const csv = md
      .map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(','))
      .join('\n')
    const tsv = md.map((r) => r.join('\t')).join('\r\n')
    const strip = (claims: typeof rows) => claims.map((c) => [c.claim_key, c.payload])
    expect(strip(parsePpvRegistry(csv))).toEqual(strip(rows))
    expect(strip(parsePpvRegistry(tsv))).toEqual(strip(rows))
    expect(new Set(rows.map((r) => r.claim_key)).size).toBe(rows.length)
  })

  it('splits tags keeping compound ones', () => {
    expect(splitTags('Tease dance dildo, Get ready with me close up')).toEqual([
      'tease',
      'dance',
      'dildo',
      'get ready with me',
      'close up',
    ])
  })
})
