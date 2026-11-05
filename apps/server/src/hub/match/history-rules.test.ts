import { describe, expect, it } from 'vitest'
import {
  buildCatalog,
  type CatalogFile,
  cameraNumbers,
  findFile,
  lossyPattern,
  type PlatformFile,
  stemOf,
  verdictOf,
  withoutNote,
} from './history-rules'
import { handleKey, nameHandle } from './names'

/**
 * The rules of the history pass one by one, without a database (SPEC §7, the audit of the catalog
 * of 05.11.2026: candidates by length alone, before the shooting, photo for video, RAW left out,
 * names Fansly spoils). All names and numbers are made up.
 */

const TZ = 'Europe/Moscow'
const CHECK = { durationMs: 200, timezone: TZ }

function ours(id: string, patch: Partial<CatalogFile> = {}): CatalogFile {
  return {
    assetId: id,
    versionId: `${id}-v1`,
    itemId: `item-${id}`,
    itemType: 'SET',
    blobs: [`blob-${id}`],
    isVideo: false,
    durationMs: null,
    width: 3024,
    height: 4032,
    shotDay: '2026-03-01',
    ...patch,
  }
}

const photo = (names: (string | null)[], patch: Partial<PlatformFile> = {}): PlatformFile => ({
  names,
  isVideo: false,
  durationMs: null,
  width: 3024,
  height: 4032,
  seenAt: '2026-03-12T17:00:00.000Z',
  ...patch,
})

const video = (names: (string | null)[], patch: Partial<PlatformFile> = {}): PlatformFile =>
  photo(names, { isVideo: true, durationMs: 20_000, width: 1080, height: 1920, ...patch })

interface Entry {
  file: CatalogFile
  names?: string[]
  handle?: [string, string, number | null]
}

function catalogOf(entries: Entry[]) {
  return buildCatalog(
    entries.map((entry) => entry.file),
    entries.flatMap((entry) =>
      (entry.names ?? []).map((name) => ({ assetId: entry.file.assetId, name })),
    ),
    entries.flatMap((entry) => {
      const key = entry.handle ? handleKey(...entry.handle) : null
      return key ? [{ key, assetId: entry.file.assetId }] : []
    }),
  )
}

describe('имена', () => {
  it('основа имени: без папки и расширения, NFC, строчными', () => {
    expect(stemOf('/5. Sets/01.07.26/IMG_5002.MOV')).toBe('img_5002')
    expect(stemOf(null)).toBe('')
  })

  it('имя скачивания ContentOps указывает объект и файл, номер показа не важен', () => {
    expect(nameHandle('SXT-003_85_pic67.jpeg')).toBe('SXT-3|pic67')
    expect(nameHandle('SXT-002_pic03')).toBe('SXT-2|pic03')
    expect(nameHandle('FYP-0412_zerkalo_master_u2.mp4')).toBe('FYP-412|u2')
    expect(nameHandle('IMG_5001.jpeg')).toBeNull()
  })

  it('потери Fansly: пометка в скобках, номер камеры внутри длинного имени', () => {
    expect(withoutNote('img_8211 (2)')).toBe('img_8211')
    expect(withoutNote('never again (louder)')).toBe('never again')
    expect(withoutNote('reel(18)')).toBeNull()
    expect(cameraNumbers('081__?????__???????__img_5002')).toEqual(['img_5002'])
    expect(cameraNumbers('036__scene__img_5003face')).toEqual(['img_5003'])
    expect(cameraNumbers('img_5002')).toEqual([])
  })

  it('`?` вместо кириллицы — шаблон, только когда от имени что-то осталось', () => {
    // A name from a Mac keeps «й» as two code points (NFD): Fansly gives a `?` for each.
    const name = '02 — синяя рубашка (с музыкой)'.normalize('NFD')
    expect(lossyPattern('02 — ????? ??????? (? ????????)')?.test(name)).toBe(true)
    expect(lossyPattern('02 — ????? ???????')?.test('02 — sinyaya rubash')).toBe(false)
    expect(lossyPattern('???????????')).toBeNull()
    expect(lossyPattern('???')).toBeNull()
    expect(lossyPattern('img_5002')).toBeNull()
  })
})

describe('кандидат только по имени, длительность и размер его проверяют', () => {
  it('одна длительность и размер кадра без имени — подсказка, не кандидат', () => {
    const catalog = catalogOf([
      { file: ours('fyp', { isVideo: true, durationMs: 9_000, width: 1080, height: 1920 }) },
    ])
    const found = findFile(video(['reel(18).mp4'], { durationMs: 9_090 }), catalog, CHECK)
    expect(found).toEqual({ kind: 'shape_hint' })
    expect(verdictOf([found])).toBeNull()
    expect(findFile(photo(['photo.jpeg']), catalogOf([{ file: ours('a') }]), CHECK)).toEqual({
      kind: 'photo_hint',
    })
  })

  it('фото не совпадает с видео того же номера IMG', () => {
    const catalog = catalogOf([
      { file: ours('clip', { isVideo: true, durationMs: 23_900 }), names: ['IMG_6001.MOV'] },
    ])
    expect(findFile(photo(['IMG_6001.jpeg']), catalog, CHECK)).toEqual({
      kind: 'rejected',
      reason: 'kind',
    })
  })

  it('пост или заливка раньше дня съёмки файла — не он; тёзка, снятый позже, отпадает', () => {
    const catalog = catalogOf([
      { file: ours('april', { shotDay: '2026-04-08' }), names: ['IMG_6002.JPG'] },
      { file: ours('october', { shotDay: '2026-10-28' }), names: ['IMG_6002.JPG'] },
    ])
    const found = findFile(
      photo(['IMG_6002.jpeg'], { seenAt: '2026-06-30T15:21:00Z' }),
      catalog,
      CHECK,
    )
    expect(verdictOf([found])).toMatchObject({ itemId: 'item-april' })
    expect(
      findFile(photo(['IMG_6002.jpeg'], { seenAt: '2026-03-01T10:00:00Z' }), catalog, CHECK),
    ).toEqual({ kind: 'rejected', reason: 'date' })
  })

  it('день — по времени модели: 23:30 МСК тот же день, что и съёмка', () => {
    const catalog = catalogOf([
      { file: ours('a', { shotDay: '2026-03-12' }), names: ['IMG_5001.JPG'] },
    ])
    expect(
      verdictOf([
        findFile(photo(['IMG_5001.jpeg'], { seenAt: '2026-03-12T20:30:00Z' }), catalog, CHECK),
      ]),
    ).toMatchObject({ itemId: 'item-a' })
    expect(
      findFile(photo(['IMG_5001.jpeg'], { seenAt: '2026-03-11T20:30:00Z' }), catalog, CHECK),
    ).toEqual({ kind: 'rejected', reason: 'date' })
  })

  it('видео с тем же именем, но другой длительностью — другой монтаж', () => {
    const catalog = catalogOf([
      { file: ours('clip', { isVideo: true, durationMs: 15_500 }), names: ['IMG_6003.MOV'] },
    ])
    const file = video(['IMG_6003.mp4'], { durationMs: 15_750 })
    expect(findFile(file, catalog, CHECK)).toEqual({ kind: 'rejected', reason: 'duration' })
    // No `hub_exact_duration_ms` — lengths are not checked (SPEC §7 «Настройки»).
    expect(findFile(file, catalog, { ...CHECK, durationMs: null })).toMatchObject({ kind: 'name' })
  })

  it('сырьё — такой же объект: файл находит свой RAW', () => {
    const catalog = catalogOf([
      {
        file: ours('raw', { itemType: 'RAW', width: 960, height: 1280, shotDay: null }),
        names: ['0B8F3C2A-5D41-4E7B-9A6C-1F2E3D4C5B6A.JPG'],
      },
    ])
    const found = findFile(photo(['0B8F3C2A-5D41-4E7B-9A6C-1F2E3D4C5B6A.jpeg']), catalog, CHECK)
    expect(verdictOf([found])).toMatchObject({ itemId: 'item-raw' })
  })

  it('из тёзок одного дня берётся тот, у кого совпал размер кадра; одинаковые — спор', () => {
    const catalog = catalogOf([
      { file: ours('ppv', { width: 4032, height: 3024 }), names: ['IMG_6004.JPG'] },
      { file: ours('copy', { width: 1440, height: 1080 }), names: ['IMG_6004.jpg'] },
    ])
    const sized = findFile(photo(['IMG_6004.jpeg'], { width: 4032, height: 3024 }), catalog, CHECK)
    expect(verdictOf([sized])).toMatchObject({ itemId: 'item-ppv' })
    const both = catalogOf([
      { file: ours('a'), names: ['IMG_6005.JPG'] },
      { file: ours('b'), names: ['IMG_6005.JPG'] },
    ])
    expect(verdictOf([findFile(photo(['IMG_6005.jpeg']), both, CHECK)])).toBe('disputed')
  })
})

describe('имена на платформе', () => {
  it('в vault подпись карточки не прячет имя залитого файла: старое имя первым', () => {
    const catalog = catalogOf([
      { file: ours('pic03', { itemId: 'item-2' }), handle: ['SXT-2', 'pic', 3] },
      { file: ours('img6006', { itemId: 'item-9' }), names: ['IMG_6006.JPG'] },
    ])
    const found = findFile(photo(['SXT-002_pic03.jpeg', 'IMG_6006.jpeg']), catalog, CHECK)
    expect(found).toMatchObject({ kind: 'name', assets: [{ assetId: 'img6006' }] })
  })

  it('имя скачивания: файл по роли и номеру; не тот по длительности — единственный файл объекта той же длины', () => {
    const clip = (n: number, ms: number) =>
      ({
        file: ours(`clip${n}`, {
          itemId: 'item-sxt3',
          itemType: 'SXT',
          isVideo: true,
          durationMs: ms,
          width: 2160,
          height: 3840,
        }),
        handle: ['SXT-3', 'clip', n],
      }) satisfies Entry
    const catalog = catalogOf([clip(3, 22_767), clip(8, 113_087)])
    const found = findFile(
      video(['SXT-003_09_clip03.mp4'], { durationMs: 113_087, width: 2160, height: 3840 }),
      catalog,
      CHECK,
    )
    expect(found).toMatchObject({ kind: 'download_name', assets: [{ assetId: 'clip8' }] })
  })

  it('`?` на месте кириллицы, пометка «(louder)», номер камеры внутри имени', () => {
    const fyp = (id: string, ms: number) =>
      ours(id, { itemType: 'FYP', isVideo: true, durationMs: ms, width: 1080, height: 1920 })
    const catalog = catalogOf([
      { file: fyp('wet', 5_800), names: ['02 — синяя рубашка (с музыкой).mov'] },
      { file: fyp('again', 6_176), names: ['Never again.mp4'] },
      { file: ours('sxt', { isVideo: true, durationMs: 31_000 }), names: ['IMG_5002.MOV'] },
    ])
    const lossy = (name: string, ms: number) =>
      findFile(video([name], { durationMs: ms }), catalog, CHECK)
    expect(lossy('02 — ????? ??????? (? ????????).mp4', 5_800)).toMatchObject({
      kind: 'lossy_name',
      assets: [{ assetId: 'wet' }],
    })
    expect(lossy('Never again (louder).mp4', 6_176)).toMatchObject({
      assets: [{ assetId: 'again' }],
    })
    expect(lossy('081__?????__???????_?????__IMG_5002.mp4', 31_000)).toMatchObject({
      assets: [{ assetId: 'sxt' }],
    })
  })

  it('кастом с байтами PPV — это PPV из кастома', () => {
    const master = (id: string, itemType: string) =>
      ours(id, {
        itemId: `item-${id}`,
        itemType,
        blobs: ['same-bytes'],
        isVideo: true,
        durationMs: 499_243,
        width: 1080,
        height: 1920,
      })
    const catalog = catalogOf([
      { file: master('cus', 'CUS'), names: ['IMG_6007.MOV'] },
      { file: master('ppv', 'PPV') },
    ])
    const found = findFile(video(['IMG_6007.mp4'], { durationMs: 499_243 }), catalog, CHECK)
    expect(verdictOf([found])).toMatchObject({ itemId: 'item-ppv' })
  })

  it('файлы поста из двух объектов — спор, не догадка', () => {
    const catalog = catalogOf([
      { file: ours('a'), names: ['IMG_6008.JPG'] },
      { file: ours('b', { itemId: 'item-other' }), names: ['IMG_6009.JPG'] },
    ])
    const found = ['IMG_6008.jpeg', 'IMG_6009.jpeg'].map((name) =>
      findFile(photo([name]), catalog, CHECK),
    )
    expect(verdictOf(found)).toBe('disputed')
  })
})
