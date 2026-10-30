import { describe, expect, it } from 'vitest'
import { mediaKindOf } from './grouping'

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
