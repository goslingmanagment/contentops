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
import { backlogCount, backlogGroups, surfaceFor } from './backlog'

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
  it('совпадает с ответом сервера на каждой вкладке: группы, числа и «уже в плане»', async () => {
    for (const account of await accounts()) {
      const backlog = pageBacklog(items, summaries, account)
      const page = await api.objects.notUploaded({
        params: lora,
        query: { account: account.code },
      })
      const local = [...backlog.byType]
        .filter(([, entries]) => entries.length > 0)
        .map(([type, entries]) => ({ type, ids: entries.map((entry) => entry.id).sort() }))
      const server = page.groups.map((group) => ({
        type: group.type,
        ids: [...group.item_ids].sort(),
      }))
      expect(local).toEqual(server)
      expect(backlog.planned.length).toBe(page.planned_hidden)
      expect(backlogCount(backlog)).toBe(
        page.tabs.find((tab) => tab.account === account.code)?.count,
      )
    }
  })

  it('числа DESIGN §9.3: Fansly 2 — 4 PPV · 14 сетов · 12 лайф, фупов 488', async () => {
    const fansly2 = (await accounts()).find((account) => account.code === 'lora-2')
    if (!fansly2) throw new Error('нет Fansly 2')
    const backlog = pageBacklog(items, summaries, fansly2)
    const counts = Object.fromEntries(
      [...backlog.byType].map(([type, entries]) => [type, entries.length]),
    )
    expect(counts).toMatchObject({ ppv: 4, set: 14, life: 12, fyp: 488 })
  })

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
