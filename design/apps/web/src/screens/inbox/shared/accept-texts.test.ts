import type { AcceptManyResult } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { acceptManyMessage } from './accept-texts'

const ok = (id: string, item: string, how: 'new' | 'extend' = 'new') => ({
  id,
  ok: true,
  code: null,
  accepted: { item_id: item, how, next_step: null },
})
const refused = (id: string) => ({ id, ok: false, code: 'accept_blocked', accepted: null })

describe('итог «Принять N»', () => {
  it('называет, чем стала каждая группа', () => {
    const result: AcceptManyResult = {
      results: [
        ok('a', 'SET-075'),
        ok('b', 'LIFE-192'),
        ok('c', 'SET-074', 'extend'),
        ok('d', 'PRM-017'),
      ],
    }
    expect(acceptManyMessage(result)).toBe('Принято: SET-075, LIFE-192, + в SET-074, PRM-017')
  })

  it('длинный пакет — три имени и «и ещё», непрошедшие — числом', () => {
    const result: AcceptManyResult = {
      results: [
        ok('a', 'RAW-0215'),
        ok('b', 'RAW-0216'),
        ok('c', 'RAW-0217'),
        ok('d', 'RAW-0218'),
        ok('e', 'RAW-0219'),
        refused('f'),
      ],
    }
    expect(acceptManyMessage(result)).toBe(
      'Принято: RAW-0215, RAW-0216, RAW-0217 и ещё 2 · 1 не готова',
    )
  })
})
