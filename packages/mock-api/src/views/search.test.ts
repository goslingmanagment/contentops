import { describe, expect, it } from 'vitest'
import { createWorld } from '../fixtures/world'
import type { ModelWorld } from '../fixtures/world-types'
import { searchModel } from './search'

const world = createWorld()
const lora = world.models.get('lora') as ModelWorld
const search = (query: string) => searchModel(world, lora, query)
const ids = (query: string) => search(query).groups.flatMap((group) => group.item_ids)
const types = (query: string) => search(query).groups.map((group) => group.type)
const total = (query: string) => search(query).groups.reduce((sum, group) => sum + group.total, 0)

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
