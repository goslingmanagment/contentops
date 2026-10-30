import { describe, expect, it } from 'vitest'
import type { HubFile, ReceiptEntry, RowFile } from './load'
import { nameCore } from './names'
import {
  countFits,
  fileExact,
  hubSurface,
  inWindow,
  isUnambiguous,
  judgePair,
  looksLikeAd,
} from './rules'

/** The rules of SPEC §7 «Правила сопоставления» one by one, without a database. */

const NAME = 'FYP-0801_zerkalo_master__lora-1_2026-10-29_0300.mp4'

function receipts(entry: Partial<ReceiptEntry> = {}) {
  const core = nameCore(NAME)
  if (!core) throw new Error('name')
  return new Map([
    [
      core.key,
      [
        {
          id: 'entry-1',
          core,
          assetId: 'asset-1',
          versionId: 'version-1',
          itemId: 'item-1',
          durationMs: 9_000,
          width: 1080,
          height: 1920,
          ...entry,
        },
      ],
    ],
  ])
}

const video = (patch: Partial<HubFile> = {}): HubFile => ({
  attachmentId: 'att-1',
  observationId: 'obs-1',
  role: 'main',
  linkState: 'resolved',
  contentType: 1,
  mediaRef: 'media-1',
  mediaOfferRef: 'offer-1',
  filename: NAME,
  isVideo: true,
  durationMs: 9_100,
  width: 1080,
  height: 1920,
  createdAtPlatform: null,
  matchedVersionId: null,
  receiptEntryId: null,
  matchStrength: 'none',
  ...patch,
})

describe('точное по имени', () => {
  it('имя скачивания, квитанция, размеры и длительность — точное; обе формы имени, расширение не важно', () => {
    expect(fileExact(video(), receipts(), 200, 'fansly').strength).toBe('exact')
    const short = video({ filename: 'FYP-0801_zerkalo_master.MOV' })
    expect(fileExact(short, receipts(), 200, 'fansly').strength).toBe('exact')
    // Rotated: the pair of sizes without rotation.
    expect(
      fileExact(video({ width: 1920, height: 1080 }), receipts(), 200, 'fansly').strength,
    ).toBe('exact')
  })

  it('без квитанции, с другими размерами или длительностью — не точное', () => {
    expect(fileExact(video(), new Map(), 200, 'fansly')).toMatchObject({
      strength: 'none',
      nameOnly: true,
    })
    expect(fileExact(video({ width: 720, height: 1280 }), receipts(), 200, 'fansly').strength).toBe(
      'none',
    )
    expect(fileExact(video({ durationMs: 9_400 }), receipts(), 200, 'fansly').strength).toBe('none')
  })

  it('без hub_exact_duration_ms видео точным не бывает; фото сверяется размерами', () => {
    expect(fileExact(video(), receipts(), null, 'fansly').strength).toBe('none')
    const photo = video({ isVideo: false, durationMs: null })
    expect(fileExact(photo, receipts({ durationMs: null }), null, 'fansly').strength).toBe('exact')
  })

  it('превью с именем основного файла и OnlyFans точного не дают', () => {
    expect(fileExact(video({ role: 'offer_preview' }), receipts(), 200, 'fansly').strength).toBe(
      'none',
    )
    expect(fileExact(video(), receipts(), 200, 'onlyfans').strength).toBe('none')
  })
})

describe('поверхность (V3)', () => {
  it('просмотры For You — FYP; флаг 4 или нет видео — стена; иначе неизвестно', () => {
    expect(hubSurface({ forYouViews: 5, fypFlags: 0, hasVideo: true }, 'fansly')).toBe('fyp')
    expect(hubSurface({ forYouViews: 0, fypFlags: 4, hasVideo: true }, 'fansly')).toBe('wall')
    expect(hubSurface({ forYouViews: 0, fypFlags: 0, hasVideo: false }, 'fansly')).toBe('wall')
    expect(hubSurface({ forYouViews: 0, fypFlags: 2, hasVideo: true }, 'fansly')).toBeNull()
    expect(hubSurface({ forYouViews: 0, fypFlags: null, hasVideo: true }, 'onlyfans')).toBe('wall')
  })
})

describe('кандидат', () => {
  it('окно: ± допуск от слота, строка без времени — весь местный день, без допуска — только такие', () => {
    const row = {
      slotAt: '2026-10-29T00:00:00.000Z',
      slotTime: '03:00',
      dayStart: '2026-10-28T21:00:00.000Z',
      dayEnd: '2026-10-29T21:00:00.000Z',
    }
    expect(inWindow(row, '2026-10-29T00:29:00.000Z', 30)).toBe(true)
    expect(inWindow(row, '2026-10-29T00:31:00.000Z', 30)).toBe(false)
    expect(inWindow(row, '2026-10-29T00:01:00.000Z', null)).toBe(false)
    expect(inWindow({ ...row, slotTime: null }, '2026-10-29T20:59:00.000Z', null)).toBe(true)
  })

  it('число основных файлов: одиночный — жёстко, пачка — ±1', () => {
    expect(countFits(1, 1)).toBe(true)
    expect(countFits(1, 2)).toBe(false)
    expect(countFits(18, 17)).toBe(true)
    expect(countFits(18, 19)).toBe(true)
    expect(countFits(18, 16)).toBe(false)
    expect(countFits(2, 1)).toBe(false)
  })

  const mine: RowFile = {
    assetId: 'asset-1',
    versionId: 'version-1',
    role: 'master',
    isVideo: true,
    durationMs: 9_000,
    width: 1080,
    height: 1920,
  }

  it('файл, точно принадлежащий другому объекту, исключает пару', () => {
    const exact = new Map([
      [
        'att-1',
        {
          strength: 'exact' as const,
          versionId: 'v-x',
          assetId: 'asset-x',
          itemId: 'item-x',
          receiptEntryId: 'e',
          issuedMs: 1,
          nameOnly: false,
        },
      ],
    ])
    expect(
      judgePair(
        { mains: [mine], itemId: 'item-1' },
        { mains: [video()] },
        exact,
        new Map(),
        'fansly',
      ),
    ).toBeNull()
  })

  it('массово — только Fansly, один вариант, равное число, время и длительность в допуске', () => {
    const base = {
      platform: 'fansly' as const,
      kind: 'candidate' as const,
      variants: 1,
      rowsOfPost: 1,
      offsetMin: 4,
      toleranceMin: 30,
      rowFiles: 1,
      postFiles: 1,
      ours: [mine],
      theirs: [video()],
      durationMs: 200,
    }
    expect(isUnambiguous(base)).toBe(true)
    expect(isUnambiguous({ ...base, platform: 'onlyfans' })).toBe(false)
    expect(isUnambiguous({ ...base, variants: 2 })).toBe(false)
    expect(isUnambiguous({ ...base, durationMs: null })).toBe(false)
    expect(isUnambiguous({ ...base, theirs: [video({ durationMs: 9_500 })] })).toBe(false)
    expect(isUnambiguous({ ...base, rowFiles: 3, postFiles: 4 })).toBe(false)
  })
})

describe('реклама чужой страницы', () => {
  it('метка или чужой @ник; свой ник рекламой не делает; без настройки — выключено', () => {
    const markers = { tags: ['#ads'], ownHandles: ['loravie'] }
    expect(looksLikeAd('Go see @someone #ads', markers)).toBe(true)
    expect(looksLikeAd('Collab with @someone', markers)).toBe(true)
    expect(looksLikeAd('New post from @loravie', markers)).toBe(false)
    expect(looksLikeAd('#ads', null)).toBe(false)
  })
})
