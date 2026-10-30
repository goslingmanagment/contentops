import { describe, expect, it } from 'vitest'
import { components, dropboxPath, isUnder, parentPath, sourcePath, yandexPath } from './paths.ts'

describe('paths', () => {
  it('normalises the notation of roots', () => {
    expect(yandexPath('/')).toBe('disk:/')
    expect(yandexPath('disk:')).toBe('disk:/')
    expect(yandexPath('Model/')).toBe('disk:/Model')
    expect(yandexPath('disk:/Model')).toBe('disk:/Model')
    expect(dropboxPath('/')).toBe('')
    expect(dropboxPath('Model/')).toBe('/Model')
  })

  it('keeps spaces at the ends of names and `:` inside them', () => {
    expect(components('disk:/Trip /10:32 tail .mp4')).toEqual(['Trip ', '10:32 tail .mp4'])
    expect(parentPath('disk:/Trip /a.mp4')).toBe('disk:/Trip ')
    expect(parentPath('disk:/a.mp4')).toBe('disk:/')
    expect(parentPath('/Model/a.mp4')).toBe('/Model')
    expect(parentPath('/a.mp4')).toBe('')
    expect(parentPath('')).toBeNull()
  })

  it('compares NFC and, for Dropbox, case-insensitively', () => {
    const nfd = 'Йога'.normalize('NFD')
    expect(isUnder(`disk:/${nfd}/a`, 'disk:/Йога')).toBe(true)
    expect(isUnder('disk:/Model 2/a', 'disk:/Model')).toBe(false)
    expect(isUnder('/model/a', '/Model')).toBe(false)
    expect(isUnder('/model/a', '/Model', true)).toBe(true)
    expect(isUnder('/anything', '')).toBe(true)
  })

  it('cuts the root by components, so a mis-cased Dropbox parent still works', () => {
    const p = sourcePath('/MODEL/Set/a.jpg', '/Model', '/model/set/a.jpg')
    expect(p).toMatchObject({ relative: 'Set/a.jpg', lower: '/model/set/a.jpg' })
    expect(sourcePath('disk:/Model', 'disk:/Model').relative).toBe('')
    const nfd = 'й'.normalize('NFD')
    const q = sourcePath(`disk:/${nfd}.jpg`, 'disk:/')
    expect(q.raw).not.toBe(q.nfc)
    expect(q.relativeNfc).toBe('й.jpg')
  })
})
