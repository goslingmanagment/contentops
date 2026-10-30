import {
  type Account,
  type CatalogEntry,
  createApiClient,
  createFrozenClock,
  type ItemId,
  type PageSummaryEntry,
  type WeekNorm,
} from '@contentops/contracts'
import { createMockFetch, PROTOTYPE_NOW } from '@contentops/mock-api'

/**
 * Мир Лоры для модульных тестов окна «В план»: каталог, страницы, нормы и сводка по
 * страницам из заглушки API на замёрзших часах (вт 22.09, DESIGN §9.6).
 */
export interface DialogTestWorld {
  accounts: readonly Account[]
  norms: readonly WeekNorm[]
  entry: (id: ItemId) => CatalogEntry
  summaries: (id: ItemId) => readonly PageSummaryEntry[]
}

export async function loadDialogTestWorld(): Promise<DialogTestWorld> {
  const api = createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW) }),
  )
  const params = { model: 'lora' }
  const [models, catalog, summaries] = await Promise.all([
    api.admin.models({}),
    api.objects.catalogIndex({ params }),
    api.objects.pageSummaries({ params }),
  ])
  const accounts = models.items.find((model) => model.code === 'lora')?.accounts ?? []
  const norms = await Promise.all(
    accounts.map((account) => api.plan.norm({ params: { model: 'lora', account: account.code } })),
  )
  return {
    accounts,
    norms,
    entry: (id) => {
      const found = catalog.items.find((candidate) => candidate.id === id)
      if (!found) {
        throw new Error(`${id} нет в каталоге`)
      }
      return found
    },
    summaries: (id) => summaries.entries.filter((summary) => summary.item_id === id),
  }
}
