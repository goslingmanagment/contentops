import { describe, expect, it } from 'vitest'
import { searchModel } from './api/mock/views/search'
import { createWorld } from './fixtures/world'
import type { ModelWorld } from './fixtures/world-types'
import {
  entryHaystack,
  parseSearchQuery,
  SEARCH_RANK,
  searchRank,
  stemMatches,
  stemOf,
} from './search-query'

const world = createWorld()
const lora = world.models.get('lora') as ModelWorld
const search = (query: string) => searchModel(world, lora, query)
const ids = (query: string) => search(query).groups.flatMap((group) => group.item_ids)
const types = (query: string) => search(query).groups.map((group) => group.type)
const total = (query: string) => search(query).groups.reduce((sum, group) => sum + group.total, 0)

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

describe('поиск сервера на данных Лоры (DESIGN §4.7, §6.11)', () => {
  it('пример из строки поиска: «кастом в колготках» — кастомы с колготками', () => {
    const found = ids('кастом в колготках')
    expect(types('кастом в колготках')).toEqual(['custom'])
    expect(found).toEqual(expect.arrayContaining(['CUS-183', 'CUS-186']))
    // Совпадение в названии выше совпадения в тегах, внутри — новые первыми.
    expect(found.slice(0, 2)).toEqual(['CUS-186', 'CUS-183'])
  })

  it('«кружева», «фуп в чёрном», «фуп в чёрном белье» находят объекты', () => {
    expect(ids('кружева')).toContain('PPV-073')
    expect(total('кружева')).toBe(total('кружево'))
    expect(types('фуп в чёрном')).toEqual(['fyp'])
    expect(total('фуп в чёрном')).toBeGreaterThan(0)
    expect(types('фуп в чёрном белье')).toEqual(['fyp'])
    expect(ids('фуп в чёрном белье')).toContain('FYP-0022')
    expect(search('фуп в чёрном белье').timeline).toEqual([])
  })

  it('слова чаттеров: «лонг ппв» — PPV в личку, «последние сексты» — новые сверху', () => {
    expect(search('лонг ппв').groups).toEqual([expect.objectContaining({ type: 'ppv', total: 38 })])
    const sextings = search('последние сексты').groups
    expect(sextings).toEqual([expect.objectContaining({ type: 'sexting', total: 12 })])
    expect(sextings[0]?.item_ids[0]).toBe('SXT-014')
  })

  it('«анал кастом» — минута хронологии кастома', () => {
    expect(search('анал кастом').timeline).toEqual([
      { item_id: 'CUS-181', t_s: 250, label: 'анал' },
    ])
    expect(types('анал кастом')).toEqual(['custom'])
  })

  it('точный ID и старый номер', () => {
    expect(ids('ппв 73')).toEqual(['PPV-073'])
    expect(ids('лайф 191')).toEqual(['LIFE-191'])
    expect(ids('ппв 32')).toEqual(expect.arrayContaining(['PPV-032', 'PPV-081', 'PPV-082']))
  })

  it('описание и старые имена ищет только сервер', () => {
    expect(ids('used2')).toContain('PPV-073')
    expect(ids('свечами')).toContain('PPV-073')
  })
})
