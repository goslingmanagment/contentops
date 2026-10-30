import { describe, expect, it } from 'vitest'
import {
  entryHaystack,
  parseSearchQuery,
  SEARCH_RANK,
  searchRank,
  stemMatches,
  stemOf,
} from './search-query'

describe('разбор запроса (DESIGN §4.7)', () => {
  it('ID в любом виде — сам объект', () => {
    for (const query of ['ппв 73', 'PPV 73', 'ppv73', '[PPV-073]', 'ппв-73']) {
      expect(parseSearchQuery(query).id).toBe('PPV-073')
    }
    expect(parseSearchQuery('лайф 191').id).toBe('LIFE-191')
    expect(parseSearchQuery('#cus183').id).toBe('CUS-183')
    expect(parseSearchQuery('секст 5').id).toBe('SXT-005')
  })

  it('слова-типы и слова чаттеров — фильтр, предлоги выпадают', () => {
    expect(parseSearchQuery('кастом в колготках')).toEqual({
      id: null,
      type: 'custom',
      ppvKind: null,
      stems: ['колготк'],
    })
    expect(parseSearchQuery('фуп в чёрном белье')).toMatchObject({
      type: 'fyp',
      stems: ['черн', 'бель'],
    })
    expect(parseSearchQuery('лонг ппв')).toMatchObject({ type: 'ppv', ppvKind: 'dm', stems: [] })
    expect(parseSearchQuery('последние сексты')).toMatchObject({ type: 'sexting', stems: [] })
    expect(parseSearchQuery('кастомы')).toMatchObject({ type: 'custom', stems: [] })
  })

  it('формы слов сводятся к основе, короткие слова не режутся', () => {
    expect(stemOf('колготках')).toBe('колготк')
    expect(stemOf('кружева')).toBe('кружев')
    expect(stemOf('черном')).toBe('черн')
    expect(stemOf('белье')).toBe('бель')
    expect(stemOf('анал')).toBe('анал')
    expect(stemOf('душ')).toBe('душ')
    expect(stemOf('used2')).toBe('used2')
  })

  it('основа — начало слова, у чисел ведущие нули не считаются', () => {
    expect(stemMatches('колготк', ['колготки'])).toBe(true)
    expect(stemMatches('кружев', ['кружевное'])).toBe(true)
    expect(stemMatches('73', ['ppv', '073'])).toBe(true)
    expect(stemMatches('73', ['0173'])).toBe(false)
    expect(stemMatches('ног', ['сноуборд'])).toBe(false)
  })

  it('ID и название выше тегов', () => {
    const entry = {
      id: 'PPV-069',
      type: 'ppv' as const,
      ppv_kind: 'bundle' as const,
      aliases: [],
      title: 'Йога и анал',
      tags: ['lace'],
    }
    const haystack = entryHaystack(entry, () => 'кружево')
    expect(searchRank(parseSearchQuery('анал'), entry, haystack)).toBe(SEARCH_RANK.title)
    expect(searchRank(parseSearchQuery('кружево'), entry, haystack)).toBe(SEARCH_RANK.tags)
    expect(searchRank(parseSearchQuery('анал кружево'), entry, haystack)).toBe(SEARCH_RANK.tags)
    expect(searchRank(parseSearchQuery('сет анал'), entry, haystack)).toBeNull()
  })
})
