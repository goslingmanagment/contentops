import { describe, expect, it } from 'vitest'
import {
  exportRoleOf,
  mediaKindOf,
  notContentOf,
  packOf,
  placementOf,
  typeOfFile,
} from './grouping'

describe('mediaKindOf', () => {
  it('takes photos and videos by the media type or the extension', () => {
    expect(mediaKindOf('12.JPG', null)).toBe('image')
    expect(mediaKindOf('sexting feb/10.MOV', null)).toBe('video')
    expect(mediaKindOf('scan', 'video')).toBe('video')
    expect(mediaKindOf('notes.txt', null)).toBeNull()
  })

  it('never takes the macOS service files of a zip or a copy for media', () => {
    expect(mediaKindOf('__MACOSX/sexting feb/._12.JPG', null)).toBeNull()
    expect(mediaKindOf('._10.MOV', null)).toBeNull()
    expect(mediaKindOf('._10.MOV', 'video')).toBeNull()
    expect(mediaKindOf('5. Sextings/sexting feb.zip/__MACOSX/x.jpg', 'image')).toBeNull()
  })
})

describe('placementOf (SPEC §6.1)', () => {
  const clip = (path: string) => placementOf(path.split('/'), true)
  const photo = (path: string) => placementOf(path.split('/'), false)

  it('a video under 2. FYP or 3. Customs is an object by itself at any depth', () => {
    expect(clip('2. FYP/clip.mov')).toEqual({ kind: 'single' })
    expect(clip('2. FYP/Октябрь/clip.mov')).toEqual({ kind: 'single' })
    expect(clip('3. Customs/12-01 курьер.mov')).toEqual({ kind: 'single' })
    expect(clip('3. Customs/4 Видео/clip.mov')).toEqual({ kind: 'single' })
    expect(clip('BG/clip.mov')).toEqual({ kind: 'single' })
  })

  it('a folder of FYP sources is one shoot of raw material for FYPs', () => {
    const shoot = { type: 'RAW', purpose: 'fyp' }
    expect(clip('2. FYP/FYP исходники/clip.mov')).toEqual({
      kind: 'folder',
      folderDepth: 2,
      proposal: shoot,
    })
    expect(photo('2. FYP/Октябрь/Исходники/frame.jpg')).toEqual({
      kind: 'folder',
      folderDepth: 3,
      proposal: shoot,
    })
  })

  it('everything else keeps its folder or goes by the root', () => {
    expect(clip('1. PPV/28.10.26/master.mov')).toEqual({ kind: 'folder', folderDepth: 2 })
    expect(clip('4. Sets/Set/deep/clip.mov')).toEqual({ kind: 'folder', folderDepth: 2 })
    expect(photo('3. Customs/4 Видео/frame.jpg')).toEqual({ kind: 'folder', folderDepth: 2 })
    expect(clip('8. Other/clip.mov')).toEqual({ kind: 'root', folderDepth: 1 })
    expect(photo('2. FYP/frame.jpg')).toEqual({ kind: 'root', folderDepth: 1 })
    expect(clip('clip.mov')).toEqual({ kind: 'root', folderDepth: 0 })
  })

  it('in 9. SMM the folder right above the files is the group; its path may name a channel', () => {
    expect(photo('9. SMM/Gif сайты/Октябрь/нюд/a.jpg')).toEqual({
      kind: 'folder',
      folderDepth: 4,
      proposal: { type: 'PRM', purpose: null, channelFrom: ['Gif сайты', 'Октябрь', 'нюд'] },
    })
    expect(clip('9. SMM/Instagram/b.mov')).toMatchObject({ kind: 'folder', folderDepth: 2 })
    expect(photo('9. SMM/a.jpg')).toEqual({ kind: 'root', folderDepth: 1 })
  })

  it('a photo in 2. FYP does not claim to be a FYP', () => {
    expect(typeOfFile('2. FYP', true)).toBe('FYP')
    expect(typeOfFile('2. FYP', false)).toBeNull()
    expect(typeOfFile('3. Customs', false)).toBe('CUS')
  })
})

describe('a tree a Telegram mirror fills (Ари, SPEC §6.1, §6.3)', () => {
  const clip = (path: string) => placementOf(path.split('/'), true)
  const photo = (path: string) => placementOf(path.split('/'), false)
  const raw = { type: 'RAW', purpose: 'fyp' }

  it('in 2. FYP a day folder and the takes of a task are raw for FYPs, a group per day or task', () => {
    expect(clip('2. FYP/01.11.26/IMG_0110.MOV')).toEqual({
      kind: 'folder',
      folderDepth: 2,
      proposal: raw,
    })
    // The takes belong to their task, not to the cycle of sources above it.
    expect(clip('2. FYP/1. Цикл 1 март — исходники/FYP 01 — Микрофлеш/Дубли/IMG_1.MOV')).toEqual({
      kind: 'folder',
      folderDepth: 3,
      proposal: raw,
    })
    expect(photo('2. FYP/3. Цикл 3 сентябрь — исходники/FYP 12/IMG_2.JPG')).toEqual({
      kind: 'folder',
      folderDepth: 3,
      proposal: raw,
    })
    expect(clip('2. FYP/Дубли/IMG_3.MOV')).toEqual({
      kind: 'folder',
      folderDepth: 2,
      proposal: raw,
    })
    // Without a day, takes or sources a clip of the root is a ready FYP, as before.
    expect(clip('2. FYP/Октябрь/clip.mov')).toEqual({ kind: 'single' })
  })

  it('a clip of 7. Монтажи is a FYP by itself; a folder named by an ID holds copies of it', () => {
    expect(clip('7. Монтажи/Алиса/Ari 02.mov')).toEqual({ kind: 'single' })
    expect(typeOfFile('7. Монтажи', true)).toBe('FYP')
    expect(typeOfFile('7. Монтажи', false)).toBeNull()
    expect(photo('7. Монтажи/Алиса/обложка.jpg')).toEqual({ kind: 'folder', folderDepth: 2 })
    const copy = {
      kind: 'folder',
      folderDepth: 3,
      proposal: { type: 'PPV', purpose: null, pack: { type: 'PPV', number: 18 } },
    }
    expect(clip('7. Монтажи/Агент/PPV-018/PPV-018_tank_teaser__0m14s.mp4')).toEqual(copy)
    expect(photo('7. Монтажи/Агент/PPV-018/PPV-018_tank_pic01.jpg')).toEqual(copy)
  })

  it('a day folder deeper in a root is its own group; one right in a root stays its folder', () => {
    expect(photo('8. Other/личка/02.11.26/227295.jpg')).toEqual({ kind: 'folder', folderDepth: 3 })
    expect(photo('8. Other/чат группы/01.11.26/2915.jpg')).toEqual({
      kind: 'folder',
      folderDepth: 3,
    })
    expect(photo('5. Sextings/01.11.26/IMG_0174.JPG')).toEqual({ kind: 'folder', folderDepth: 2 })
    expect(clip('4. Sets/01.11.26/IMG_0200.MOV')).toEqual({ kind: 'folder', folderDepth: 2 })
  })

  it('a pack names its number and title; brackets and a mention elsewhere do not', () => {
    expect(photo('1. PPV/PPV-018 Белая майка, масло/PPV-018_tank_pic01.jpg')).toEqual({
      kind: 'folder',
      folderDepth: 2,
      proposal: {
        type: 'PPV',
        purpose: null,
        title: 'Белая майка, масло',
        pack: { type: 'PPV', number: 18 },
      },
    })
    expect(packOf('5. Sextings', '01.07.26 SEX-001 пак')).toMatchObject({ type: 'SXT', number: 1 })
    expect(packOf('5. Sextings', '18.10.26 SXT-002 Белое бельё')).toMatchObject({
      type: 'SXT',
      number: 2,
      title: 'Белое бельё',
    })
    expect(packOf('1. PPV', '[PPV-077]_halloween_30.10.26')).toBeNull()
    expect(packOf('5. Sextings', 'PPV-001 не тот раздел')).toBeNull()
    expect(packOf('7. Монтажи', 'PPV-001')).toBeNull()
  })

  it("not content takes no draft: its folders and the model's list, as the import reads them", () => {
    const list = ['_опись', '5. Sextings/18.10.26 SXT-002 Белое бельё/порядок.jpg']
    const of = (path: string) => notContentOf(path.split('/'), list)
    expect(of('3. Customs/карточки и рефы заказов/03.11.26_3033.jpg')).toBe(
      'рефы и карточки заказов',
    )
    expect(of('2. FYP/ТЗ рефы/13.10.26/IMG_1.MOV')).toBe('рефы и карточки заказов')
    expect(of('8. Other/не контент/личка/1.jpg')).toBe('не контент')
    expect(of('_опись/manifest.jpg')).toBe('по списку модели')
    expect(of('5. Sextings/18.10.26 SXT-002 Белое бельё/порядок.jpg')).toBe('по списку модели')
    // «FYP 02 — Повторить реф» is a task with takes, not a reference.
    expect(of('2. FYP/2. Цикл 2 июнь/FYP 02 — Повторить реф/IMG_2.MOV')).toBeNull()
    expect(of('5. Sextings/01.11.26/IMG_0174.JPG')).toBeNull()
  })

  it('an export name says the role, its number and the place in the order of showing', () => {
    expect(exportRoleOf('PPV-001_white-lingerie_master__9m06s.mov')).toEqual({
      type: 'PPV',
      number: 1,
      role: 'master',
      ordinal: null,
      position: null,
    })
    expect(exportRoleOf('PPV-002_skirt_raw03__2m03s.mov')).toMatchObject({
      role: 'raw',
      ordinal: 3,
    })
    expect(exportRoleOf('SXT-002_04_clip01.mov')).toMatchObject({
      type: 'SXT',
      role: 'clip',
      ordinal: 1,
      position: 4,
    })
    expect(exportRoleOf('IMG_8012.MOV')).toBeNull()
    expect(exportRoleOf('FYP-0412_yoga_cap__lora-2_2026-08-27_1900.txt')).toBeNull()
  })
})
