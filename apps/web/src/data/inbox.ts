import {
  type AcceptCommand,
  type DecideCommand,
  type InboxGroup,
  type InboxList,
  type ItemId,
  type ItemType,
  inboxSectionOf,
  type LabelTarget,
  type ModelCode,
  type UpdateDraftCommand,
  type UpdateDraftFilesCommand,
  type VideoInSetDestination,
} from '@contentops/contracts'
import {
  type InfiniteData,
  type QueryKey,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/** «Приехало» опрашивается раз в 10 с, пока в нём что-то готовится (DESIGN §3.13, п. 8). */
const INBOX_POLL_MS = 10_000

/**
 * Групп на странице списка (SPEC §11.2). Сервер считает состояние каждой группы, а файлы,
 * миниатюры и кандидатов читает только для страницы; опрос перечитывает только загруженные
 * страницы — обычно одну.
 */
const INBOX_PAGE = 100

export type InboxView = 'active' | 'accepted' | 'rejected'

type InboxPages = InfiniteData<InboxList, string | null>

/** Страницы одним списком: числа — с первой, группы — подряд, без повторов. */
function mergePages(data: InboxPages): InboxList {
  const [first] = data.pages
  const seen = new Set<string>()
  const items = data.pages.flatMap((page) =>
    page.items.filter((group) => !seen.has(group.id) && seen.add(group.id)),
  )
  return {
    ...(first as InboxList),
    items,
    next_cursor: data.pages.at(-1)?.next_cursor ?? null,
  }
}

export function useInboxList(model: ModelCode, view: InboxView = 'active') {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: queryKeys.inbox(model, view),
    queryFn: ({ pageParam, signal }) =>
      api.inbox.list({
        params: { model },
        query: { state: view, limit: INBOX_PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    select: mergePages,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((group) => group.state.kind === 'preparing'),
      )
        ? INBOX_POLL_MS
        : false,
  })
}

/**
 * Группа целиком для панели решения: в списке у большой группы только первые файлы
 * (`files` короче `file_count`). Состояние и поля — из списка (он свежее, его опрашивают),
 * файлы — из группы; перечитывается, когда меняется версия группы или стадия подготовки.
 */
export function useWholeInboxGroup(model: ModelCode, group: InboxGroup | null): InboxGroup | null {
  const api = useApi()
  const partial = group !== null && group.files.length < group.file_count
  const stage = group?.state.kind === 'preparing' ? group.state.stage : group?.state.kind
  const whole = useQuery({
    queryKey: [...queryKeys.inboxGroup(model, group?.id ?? ''), group?.version ?? 0, stage],
    queryFn: ({ signal }) =>
      api.inbox.get({ params: { model, group: group?.id as string }, signal }),
    enabled: partial,
  })
  return useMemo(() => {
    if (!group || !partial || whole.data?.id !== group.id) {
      return group
    }
    return { ...group, files: whole.data.files }
  }, [group, partial, whole.data])
}

/** «Разбор старого»: ход по корням, метки и спорное. */
/** Слова к решению спорного: причина или тип и номер (DisputeOption.input). */
export interface DisputeAnswer {
  reason?: string
  type?: ItemType
  number?: number
  contractor?: string
}

export function useLegacyReview(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.legacy(model),
    queryFn: ({ signal }) => api.legacy.get({ params: { model }, signal }),
  })
}

/** Что решение в «Приехало» задевает за его пределами. */
export interface InboxTouched {
  /** Объекты: цель дополнения или исправления, новый объект из пакета. */
  items?: readonly ItemId[]
  /** Заказы, которым пришла сдача или исправление по правке. */
  orders?: readonly string[]
  /** Монтаж встал в строку плана; дата строки в ответе не приходит — все дни и недели. */
  plan?: boolean
}

/**
 * Что перечитать после решения в «Приехало»: списки, счётчик колонки и индекс каталога, а
 * ещё карточки задетых объектов, оба списка заказов и сами заказы, дни и недели плана —
 * «Открыть» из полоски и «Кастомы › Заказы» показывают уже принятое.
 */
export function inboxChangedKeys(model: ModelCode, touched: InboxTouched = {}): QueryKey[] {
  const orders = touched.orders ?? []
  return [
    queryKeys.inbox(model, 'active'),
    queryKeys.inbox(model, 'accepted'),
    queryKeys.inbox(model, 'rejected'),
    queryKeys.counters(),
    queryKeys.catalogIndex(model),
    queryKeys.pageSummaries(model),
    ...(touched.items ?? []).map((item) => queryKeys.item(model, item)),
    ...(orders.length > 0
      ? [queryKeys.orders(model, 'open'), queryKeys.orders(model, 'closed')]
      : []),
    ...orders.map((order) => queryKeys.order(model, order)),
    // Префиксы «все дни» и «все недели» — те же ключи без даты.
    ...(touched.plan
      ? [queryKeys.planDay(model, '', false).slice(0, 3), queryKeys.planWeek(model, '').slice(0, 3)]
      : []),
  ]
}

/** Объекты и заказы, которые задевает принятие группы (§4.8): цель, сдача, правка. */
export function touchedByAccept(group: InboxGroup, command?: AcceptCommand): InboxTouched {
  const note = group.state.kind === 'ready' ? group.state.note : null
  const target = note?.kind === 'extends' || note?.kind === 'fix_of' ? note.item_id : null
  const order = note?.kind === 'order_part' ? note.order_id : null
  const items = [command?.extend?.item_id, target, group.target_item]
  const orders = [order, group.fields.order_id]
  return {
    items: [...new Set(items.filter((item): item is ItemId => Boolean(item)))],
    orders: [...new Set(orders.filter((id): id is string => Boolean(id)))],
  }
}

/**
 * Ответ сервера с новой версией группы встаёт в список сразу, без перезапроса: поле
 * черновика, роль файла, порядок — видны на экране, как только их подтвердил сервер.
 */
export function usePutInboxGroup(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (group: InboxGroup) => {
      queryClient.setQueryData<InboxPages>(queryKeys.inbox(model, 'active'), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((current) => (current.id === group.id ? group : current)),
              })),
            }
          : data,
      )
    },
    [model, queryClient],
  )
}

/** Решённые группы уходят из «Нового» сразу после ответа, фокус идёт на следующую. */
export function useDropInboxGroups(model: ModelCode) {
  const queryClient = useQueryClient()
  return useCallback(
    (ids: readonly string[]) => {
      const gone = new Set(ids)
      queryClient.setQueryData<InboxPages>(queryKeys.inbox(model, 'active'), (data) => {
        if (!data) {
          return data
        }
        const removed = data.pages
          .flatMap((page) => page.items)
          .filter((group) => gone.has(group.id))
        const counted = removed.filter(
          (group) =>
            group.state.kind === 'ready' ||
            group.state.kind === 'decision' ||
            group.state.kind === 'error',
        ).length
        return {
          ...data,
          pages: data.pages.map((page, index) => {
            const items = page.items.filter((group) => !gone.has(group.id))
            if (index > 0) {
              return { ...page, items }
            }
            const sections = page.sections
              ? {
                  decision: Math.max(
                    0,
                    page.sections.decision -
                      removed.filter((group) => inboxSectionOf(group.state) === 'decision').length,
                  ),
                  ready: Math.max(
                    0,
                    page.sections.ready -
                      removed.filter((group) => inboxSectionOf(group.state) === 'ready').length,
                  ),
                  preparing: Math.max(
                    0,
                    page.sections.preparing -
                      removed.filter((group) => inboxSectionOf(group.state) === 'preparing').length,
                  ),
                }
              : undefined
            return {
              ...page,
              items,
              count: Math.max(0, page.count - counted),
              ...(sections ? { sections } : {}),
            }
          }),
        }
      })
    },
    [model, queryClient],
  )
}

/**
 * Команды «Приехало» (DESIGN §4.8–4.10) — те же запросы, что у агента приёмки. Ключ
 * повтора приходит от намерения человека; версия записи — от группы, которую он видел.
 */
export function useInboxCommands(model: ModelCode) {
  const api = useApi()
  return useMemo(
    () => ({
      update: (group: InboxGroup, patch: UpdateDraftCommand, key: string) =>
        api.inbox.update({
          params: { model, group: group.id },
          body: patch,
          ifMatch: group.version,
          idempotencyKey: key,
        }),
      files: (group: InboxGroup, change: UpdateDraftFilesCommand, key: string) =>
        api.inbox.files({
          params: { model, group: group.id },
          body: change,
          ifMatch: group.version,
          idempotencyKey: key,
        }),
      accept: (group: string, command: AcceptCommand, key: string) =>
        api.inbox.accept({ params: { model, group }, body: command, idempotencyKey: key }),
      acceptMany: (groupIds: readonly string[], key: string) =>
        api.inbox.acceptMany({
          params: { model },
          body: { group_ids: [...groupIds] },
          idempotencyKey: key,
        }),
      decide: (group: string, command: DecideCommand, key: string) =>
        api.inbox.decide({ params: { model, group }, body: command, idempotencyKey: key }),
      setType: (groupIds: readonly string[], type: ItemType, key: string) =>
        api.inbox.setType({
          params: { model },
          body: { group_ids: [...groupIds], type },
          idempotencyKey: key,
        }),
      /** «Куда видео ▾» у нескольких групп: у каждой свой производный ключ повтора. */
      videoDestination: (
        groupIds: readonly string[],
        destination: VideoInSetDestination,
        key: string,
      ) =>
        Promise.all(
          groupIds.map((group) =>
            api.inbox.decide({
              params: { model, group },
              body: { decision: 'video_in_set', destination },
              idempotencyKey: `${key}:${group}`,
            }),
          ),
        ),
      merge: (groupIds: readonly string[], key: string) =>
        api.inbox.merge({
          params: { model },
          body: { group_ids: [...groupIds] },
          idempotencyKey: key,
        }),
      split: (group: string, fileKeys: readonly string[], key: string) =>
        api.inbox.split({
          params: { model, group },
          body: { file_keys: [...fileKeys] },
          idempotencyKey: key,
        }),
      reject: (group: string, reason: string | null, key: string) =>
        api.inbox.reject({ params: { model, group }, body: { reason }, idempotencyKey: key }),
      retry: (group: string, key: string) =>
        api.inbox.retry({ params: { model, group }, idempotencyKey: key }),
      restore: (group: string, key: string) =>
        api.inbox.restore({ params: { model, group }, idempotencyKey: key }),
      download: (group: string, key: string) =>
        api.inbox.download({ params: { model, group }, idempotencyKey: key }),
      closeOrder: (order: string, key: string) =>
        api.orders.close({ params: { model, order }, idempotencyKey: key }),
      /** `folders` — «Номер занят» с выбором у каждой папки: имя папки → вариант. */
      resolveDispute: (
        dispute: string,
        option: string,
        key: string,
        folders?: Readonly<Record<string, string>>,
        extra?: DisputeAnswer,
      ) =>
        api.legacy.resolve({
          params: { model, dispute },
          body: { option, ...(folders ? { folders: { ...folders } } : {}), ...extra },
          idempotencyKey: key,
        }),
      saveLabels: (labels: readonly { label: string; target: LabelTarget | null }[], key: string) =>
        api.legacy.saveLabels({
          params: { model },
          body: { labels: [...labels] },
          idempotencyKey: key,
        }),
    }),
    [api, model],
  )
}

export type InboxCommands = ReturnType<typeof useInboxCommands>
