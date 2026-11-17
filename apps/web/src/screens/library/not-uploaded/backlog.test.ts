import {
  type ApiClient,
  type CatalogEntry,
  createApiClient,
  createFrozenClock,
} from '@contentops/contracts'
import { createMockFetch, PROTOTYPE_NOW } from '@contentops/mock-api'
import { beforeAll, describe, expect, it } from 'vitest'
import { type PageSummariesView, pageSummariesView } from '@/data/catalog'
import { pageBacklog } from '../shared/not-uploaded-index'
import { backlogGroups, surfaceFor } from './backlog'

const lora = { model: 'lora' }
let api: ApiClient
let items: readonly CatalogEntry[]
let summaries: PageSummariesView

beforeAll(async () => {
  api = createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
  items = (await api.objects.catalogIndex({ params: lora })).items
  summaries = pageSummariesView(await api.objects.pageSummaries({ params: lora }), null)
})

async function accounts() {
  const [model] = (await api.admin.models({})).items.filter(
    (candidate) => candidate.code === 'lora',
  )
  if (!model) throw new Error('нет Лоры')
  return model.accounts
}

describe('«Ещё не залито» по индексу в браузере (DESIGN §4.3)', () => {
  it('фупы свёрнуты и последние, пустые по фильтру группы не рисуются', async () => {
    const fansly2 = (await accounts()).find((account) => account.code === 'lora-2')
    if (!fansly2) throw new Error('нет Fansly 2')
    const backlog = pageBacklog(items, summaries, fansly2)
    const all = backlogGroups(backlog, {
      filter: (entries) => [...entries],
      showFyp: false,
      showPlanned: false,
    })
    expect(all.map((group) => group.kind)).toEqual(['ppv', 'life', 'set', 'fyp'])
    expect(all.at(-1)).toMatchObject({ collapsed: true, total: 488, items: [] })

    const dmOnly = backlogGroups(backlog, {
      filter: (entries) => entries.filter((entry) => entry.ppv_kind === 'dm'),
      showFyp: true,
      showPlanned: true,
    })
    expect(dmOnly.map((group) => group.kind)).toEqual(['ppv'])
  })

  it('«В план» подставляет место, только когда оно у всех выбранных одно', () => {
    const ppv = items.find((entry) => entry.type === 'ppv')
    const life = items.find((entry) => entry.type === 'life')
    const set = items.find((entry) => entry.type === 'set')
    if (!ppv || !life || !set) throw new Error('нет объектов')
    expect(surfaceFor([ppv, life])).toBe('vault')
    expect(surfaceFor([set])).toBe('wall')
    expect(surfaceFor([ppv, set])).toBeUndefined()
  })
})
