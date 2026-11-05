import { planLegacyImport } from '@contentops/legacy'
import { FIXTURE_PACKS, FIXTURE_PACKS_NOT_CONTENT } from '@contentops/legacy/fixture'
import { describe, expect, it } from 'vitest'
import { mediaKindOf } from '../intake/grouping'
import { type DoubtFile, doubtOf, doubtOfUnit } from './doubt'
import { snapshotListing } from './fixture-disk'
import { legacyUnits } from './units'

/**
 * What the import does not accept by itself (SPEC §6.3): 03.11.2026 it made a sexting of every
 * folder of Ари's `5. Sextings` and issued SXT-004…010 to photo sets, a copy from a computer, a
 * collection over two years and the drop of one night. The rules on her tree (`FIXTURE_PACKS`)
 * and on the shapes of Лора's disk, whose packs and sets must still go by themselves.
 */

const { listing, byPath } = snapshotListing(FIXTURE_PACKS)
const plan = planLegacyImport(listing, { notContent: FIXTURE_PACKS_NOT_CONTENT })
const units = legacyUnits({
  files: listing.filter((e) => !e.isDir && mediaKindOf(e.relative, null) !== null),
  byPath,
  parsed: new Map(plan.entries.map((e) => [e.path, e])),
  registry: [],
  timezone: 'Europe/Moscow',
  packs: plan.packs,
})
const askedOf = (path: string) => {
  const unit = units.find((u) => u.path === path)
  if (!unit) throw new Error(`no unit ${path}`)
  return doubtOfUnit(unit, 'Europe/Moscow')
}

describe('Ари: the sextings of a mirror', () => {
  it('a pack with its number and a pack of clips without one go by themselves', () => {
    expect(askedOf('5. Sextings/01.07.26 SEX-001 пак')).toBeNull()
    expect(askedOf('5. Sextings/18.10.26 SXT-002 Белое бельё')).toBeNull()
    expect(askedOf('5. Sextings/12.10.26 пак №2')).toBeNull()
  })

  it('photo sets wait: only photos, or one clip among many', () => {
    expect(askedOf('5. Sextings/17.04.26 розовый халтер')).toEqual({
      kind: 'photos_only',
      text: 'Только фото — это сет?',
    })
    expect(askedOf('5. Sextings/09.04.26 лонгслив леггинсы')).toEqual({
      kind: 'photos_only',
      text: 'Видео 1 из 13 — это сет?',
    })
  })

  it('a copy from a computer and a collection wait by the words of their names', () => {
    expect(askedOf('5. Sextings/с мака 30.06')).toEqual({
      kind: 'copy_or_collection',
      text: '«с мака» в имени — копия или сборник?',
    })
    expect(askedOf('5. Sextings/11.03.26 архив тизеров 2025-26')?.kind).toBe('copy_or_collection')
  })

  it('the drop of a night without a name waits, clips or not', () => {
    expect(askedOf('5. Sextings/19.10.26')).toEqual({
      kind: 'day_folder',
      text: 'Папка дня без названия — одна ли это съёмка?',
    })
  })
})

describe('Ари: the other roots', () => {
  it('a set of one shoot goes; photos two years apart are several shoots', () => {
    expect(askedOf('4. Sets/17.04.26 гардеробная')).toBeNull()
    expect(askedOf('4. Sets/10.04.26 ванная топлес')).toBeNull()
    expect(askedOf('4. Sets/20.04.26 красный топ')).toEqual({
      kind: 'several_shoots',
      text: 'Несколько съёмок: 10.02.2024–20.04.2026',
    })
    expect(askedOf('4. Sets/05-07.06.26 новая квартира (не разобрано)')?.kind).toBe(
      'copy_or_collection',
    )
  })

  it('the photos of a day of customs wait; an order folder and a day of Life go', () => {
    expect(askedOf('3. Customs/17.10.26')?.kind).toBe('day_folder')
    expect(askedOf('6. Life/31.10.26')).toBeNull()
    expect(askedOf('6. Life/11.03.26 архив селфи 2025')?.kind).toBe('copy_or_collection')
    expect(askedOf('3. Customs/05.10.26 fanfox кресло')).toBeNull()
  })

  it('clips by themselves and raw material are not asked', () => {
    const asked = units
      .filter((u) => u.grouping === 'single' || u.type === 'RAW' || u.type === 'FYP')
      .filter((u) => doubtOfUnit(u, 'Europe/Moscow') !== null)
    expect(asked.map((u) => u.path)).toEqual([])
  })
})

describe('Лора: the shapes of her disk', () => {
  const files = (videos: number, photos: number, day: string | null = null): DoubtFile[] => [
    ...Array.from({ length: videos }, (_, i) => ({ name: `${i}.mov`, video: true, shotDay: day })),
    ...Array.from({ length: photos }, (_, i) => ({ name: `${i}.jpg`, video: false, shotDay: day })),
  ]
  const folder = (type: string, unit: string, list: DoubtFile[]) =>
    doubtOf({ type, grouping: 'folder', unit, files: list })

  it('a sexting folder of clips and photos and a named set go', () => {
    // `sexting_005_pink_thong_14.03.25`: 8 clips of 58, the fewest of her packs.
    expect(folder('SXT', '5. Sextings/november', files(8, 50, '2025-11-02'))).toBeNull()
    // «старый сет» is an old set, not a collection of old files.
    expect(
      folder(
        'SET',
        '4. Sets/Posted sets/used_all_set_старый_сет_в_леггинсах_06.08(posted)',
        files(0, 39, '2025-03-12'),
      ),
    ).toBeNull()
    // Two days of one shoot (`set_джинсы_боди_прозрачный_18.02.26`: 28 and 30 January).
    expect(
      folder('SET', '4. Sets/Posted sets/set_джинсы_боди_прозрачный_18.02.26', [
        ...files(0, 7, '2026-01-28'),
        ...files(0, 7, '2026-01-30'),
      ]),
    ).toBeNull()
  })

  it('a teaser cut later is no second shoot of a PPV', () => {
    expect(
      folder('PPV', 'Старый формат/PPV/old/001 bndl 8min сетка каблуки дилдо (used_all)', [
        { name: 'full.mov', video: true, shotDay: '2025-01-14' },
        { name: 'promo.mov', video: true, shotDay: '2026-04-24' },
        ...files(0, 20, '2025-01-14'),
      ]),
    ).toBeNull()
  })

  it('a PPV without a clip, a day folder and files right in a section wait', () => {
    expect(
      folder(
        'PPV',
        'Старый формат/PPV/old/002 bndl 8min 28jan сауна/untitled folder',
        files(0, 21),
      ),
    ).toEqual({ kind: 'no_video', text: 'Нет видео — это PPV?' })
    expect(folder('SET', '4. Sets/9.10.26', files(0, 27, '2026-10-09'))?.kind).toBe('day_folder')
    expect(
      doubtOf({ type: 'SET', grouping: 'exif_day', unit: '4. Sets', files: files(0, 3) }),
    ).toEqual({ kind: 'loose_files', text: 'Файлы прямо в разделе — одна ли это съёмка?' })
    // Life by a day in its section is one life (`6. Life`, 16 days of loose photos).
    expect(
      doubtOf({ type: 'LIFE', grouping: 'exif_day', unit: '6. Life', files: files(0, 3) }),
    ).toBeNull()
  })

  it('collections of Life wait: by the words of their names, by photos of many months', () => {
    // 03.11.2026 both went by themselves as LIFE-050 and LIFE-051.
    expect(folder('LIFE', '6. Life/Life_chats', files(0, 3, '2026-09-26'))).toEqual({
      kind: 'copy_or_collection',
      text: '«chats» в имени — копия или сборник?',
    })
    expect(folder('LIFE', '6. Life/Life chats', files(0, 3))?.kind).toBe('copy_or_collection')
    expect(folder('LIFE', '6. Life/Life_others', files(0, 3))?.kind).toBe('copy_or_collection')
    expect(folder('LIFE', '6. Life/Фото для чатов', files(0, 3))?.kind).toBe('copy_or_collection')
    expect(folder('LIFE', '6. Life/misc', files(0, 3))?.kind).toBe('copy_or_collection')
    // `Life_кот`: 16 days over three years — a collection, whatever its name says.
    const months = (...days: string[]) =>
      days.map((day, i) => ({ name: `${i}.jpg`, video: false, shotDay: day }))
    expect(
      folder(
        'LIFE',
        '6. Life/Life_кот',
        months('2022-04-23', '2023-01-10', '2024-06-02', '2025-02-13'),
      ),
    ).toEqual({
      kind: 'many_months',
      text: 'Фото разных месяцев: 04.2022–02.2025 — один лайф или сборник?',
    })
    // A trip and a holiday season are one life: three months at most (`Life_новогоднее`).
    expect(
      folder('LIFE', '6. Life/posted/Life_новогоднее_30.11.26', [
        ...months('2025-11-24', '2025-12-20', '2026-01-01'),
        // A clip's day says nothing: its edit may come later.
        { name: 'v.mov', video: true, shotDay: '2026-05-01' },
      ]),
    ).toBeNull()
    expect(
      folder(
        'LIFE',
        '6. Life/posted/Life_Dubai_06.08.25/hotel',
        months('2025-07-21', '2025-07-25'),
      ),
    ).toBeNull()
  })
})
