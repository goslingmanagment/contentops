import { describe, expect, it } from 'vitest'
import { hashWithOuterQuery } from './outer-query'

describe('запрос до «#»', () => {
  it('режим прототипа переезжает в хэш, запрос хэша остаётся', () => {
    expect(hashWithOuterQuery('?as=owner', '#/lora/library/ppv?kind=dm')).toBe(
      '#/lora/library/ppv?kind=dm&as=owner',
    )
    expect(hashWithOuterQuery('?demo=hub-down&as=reader', '#/lora/plan')).toBe(
      '#/lora/plan?demo=hub-down&as=reader',
    )
  })

  it('при совпадении имени побеждает хэш; без хэша — корень', () => {
    expect(hashWithOuterQuery('?as=owner', '#/lora/journal?as=reader')).toBe(
      '#/lora/journal?as=reader',
    )
    expect(hashWithOuterQuery('?as=owner', '')).toBe('#/?as=owner')
  })

  it('без запроса до «#» адрес не трогается', () => {
    expect(hashWithOuterQuery('', '#/lora/library')).toBeNull()
  })
})
