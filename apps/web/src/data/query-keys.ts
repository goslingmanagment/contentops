import type { ModelCode } from '@contentops/contracts'

/**
 * Ключи кэша запросов в одном месте. Всё, что относится к модели, начинается с
 * `['model', <код>]`: смена модели и сброс кэша модели работают по этому префиксу.
 */
export const queryKeys = {
  session: () => ['session'] as const,
  models: () => ['models'] as const,
  counters: () => ['counters'] as const,
  integrations: () => ['integrations'] as const,
  tags: () => ['tags'] as const,
  systemState: () => ['system-state'] as const,
  people: () => ['people'] as const,
  agents: () => ['agents'] as const,
  thresholds: () => ['thresholds'] as const,
  aiSettings: () => ['ai-settings'] as const,
  mySessions: () => ['my-sessions'] as const,
  personGrants: (person: string) => ['person-grants', person] as const,

  model: (model: ModelCode) => ['model', model] as const,
  catalogIndex: (model: ModelCode) => ['model', model, 'catalog-index'] as const,
  promoContractors: (model: ModelCode) => ['model', model, 'promo-contractors'] as const,
  pageSummaries: (model: ModelCode) => ['model', model, 'page-summaries'] as const,
  recent: (model: ModelCode) => ['model', model, 'recent'] as const,
  deleted: (model: ModelCode) => ['model', model, 'deleted'] as const,
  notUploaded: (model: ModelCode, account: string) =>
    ['model', model, 'not-uploaded', account] as const,
  item: (model: ModelCode, id: string) => ['model', model, 'item', id] as const,
  search: (model: ModelCode, query: string) => ['model', model, 'search', query] as const,
  orders: (model: ModelCode, tab: 'open' | 'closed' | 'cancelled') =>
    ['model', model, 'orders', tab] as const,
  order: (model: ModelCode, id: string) => ['model', model, 'order', id] as const,
  inbox: (model: ModelCode, view: string) => ['model', model, 'inbox', view] as const,
  legacy: (model: ModelCode) => ['model', model, 'legacy'] as const,
  planDay: (model: ModelCode, date: string, mine: boolean) =>
    ['model', model, 'plan-day', date, mine] as const,
  planWeek: (model: ModelCode, week: string) => ['model', model, 'plan-week', week] as const,
  weekNorm: (model: ModelCode, account: string) => ['model', model, 'week-norm', account] as const,
  checkCases: (model: ModelCode, show: string) => ['model', model, 'check', show] as const,
  checkCase: (model: ModelCode, id: string) => ['model', model, 'check-case', id] as const,
  journal: (model: ModelCode, filter: string) => ['model', model, 'journal', filter] as const,
  promoChannels: (model: ModelCode) => ['model', model, 'promo-channels'] as const,
  promoChannel: (model: ModelCode, channel: string) =>
    ['model', model, 'promo-channel', channel] as const,
  promoCollection: (model: ModelCode, id: string) =>
    ['model', model, 'promo-collection', id] as const,
  promoHandoffs: (model: ModelCode) => ['model', model, 'promo-handoffs'] as const,
  operation: (model: ModelCode, id: string) => ['model', model, 'operation', id] as const,
}
