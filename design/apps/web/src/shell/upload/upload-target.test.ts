import { describe, expect, it } from 'vitest'
import { defaultUploadKind } from './upload-target'

describe('вид файла в окне «Загрузить» по умолчанию', () => {
  it('строка, ждущая монтаж фупа, открывает «Монтаж фупа»', () => {
    expect(
      defaultUploadKind({
        kind: 'plan-row',
        rowId: 'r1',
        title: 'RAW-0214',
        expects: 'fyp_montage',
      }),
    ).toBe('fyp_montage')
  })

  it('обычная строка и объект — тизер, без цели — «Другое»', () => {
    expect(
      defaultUploadKind({ kind: 'plan-row', rowId: 'r1', title: 'PPV-073', expects: null }),
    ).toBe('teaser')
    expect(defaultUploadKind({ kind: 'item', itemId: 'PPV-073', title: 'PPV-073' })).toBe('teaser')
    expect(defaultUploadKind(null)).toBe('other')
  })
})
