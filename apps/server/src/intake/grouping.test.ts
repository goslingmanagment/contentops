import { describe, expect, it } from 'vitest'
import { mediaKindOf, placementOf, typeOfFile } from './grouping'

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
