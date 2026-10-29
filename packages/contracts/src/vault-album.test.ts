import { describe, expect, it } from 'vitest'
import { vaultAlbumName } from './vault-album'

describe('альбом vault по норме', () => {
  it('у объекта — ID и название, у лайфа — «Lifestyle», у кастома — только ID', () => {
    expect(vaultAlbumName({ id: 'PPV-076', title: 'Нейлон и каблуки', type: 'ppv' })).toBe(
      'PPV-076 Нейлон и каблуки',
    )
    expect(vaultAlbumName({ id: 'LIFE-191', title: 'Завтрак у окна', type: 'life' })).toBe(
      'Lifestyle',
    )
    expect(vaultAlbumName({ id: 'CUS-198', title: 'Колготки', type: 'custom' })).toBe('CUS-198')
  })
})
