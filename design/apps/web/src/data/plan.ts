import type {
  AccountCode,
  CancelReason,
  CreateReleaseCommand,
  DownloadKind,
  IsoWeek,
  ItemDetail,
  ItemId,
  LocalDate,
  MarkKind,
  ModelCode,
  MoveRowCommand,
  NewPlanRow,
  PlanDownloadCommand,
  UpdateRowCommand,
  UpdateWeekNormCommand,
  WeekNorm,
} from '@contentops/contracts'
import {
  type QueryKey,
  type UseQueryResult,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/**
 * План модели (DESIGN §4.11–4.14): день, неделя, строки, нормы страниц и все команды
 * над строками. Экраны берут данные и команды только отсюда.
 */

interface PlanDayOptions {
  /** Чип «Мои»: строки, где выкладывает вошедший (фильтр, а не право). */
  mine: boolean
  /** «Отменённые · 2»: отменённые строки приходят вместе с остальными. */
  cancelled: boolean
}

export function usePlanDay(model: ModelCode, date: LocalDate, options: PlanDayOptions) {
  const api = useApi()
  const { mine, cancelled } = options
  return useQuery({
    queryKey: [...queryKeys.planDay(model, date, mine), cancelled],
    queryFn: ({ signal }) =>
      api.plan.day({ params: { model }, query: { date, mine, cancelled }, signal }),
    placeholderData: (previous) => (previous?.date === date ? previous : undefined),
  })
}

export function usePlanWeek(model: ModelCode, week: IsoWeek, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.planWeek(model, week),
    queryFn: ({ signal }) => api.plan.week({ params: { model }, query: { week }, signal }),
    enabled,
  })
}

/**
 * Карточки нескольких объектов для окна «В план»: версии фупов, чтобы каждой странице
 * досталась своя (DESIGN §4.13). Ключи те же, что у объекта, — кэш общий.
 */
export function usePlanItems(model: ModelCode, ids: readonly ItemId[]) {
  const api = useApi()
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.item(model, id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.objects.get({ params: { model, id }, signal }),
    })),
    combine: combineItems,
  })
}

function combineItems(results: readonly UseQueryResult<ItemDetail>[]) {
  return {
    items: results.flatMap((result) => (result.data ? [result.data] : [])),
    ready: results.every((result) => !result.isPending),
  }
}

/**
 * Объект по требованию — для строки, поставленной перетаскиванием в неделе: версии фупа
 * нужны в момент, когда плитку отпустили. Кэш общий с экраном объекта.
 */
export function useItemLoader(model: ModelCode) {
  const api = useApi()
  const queryClient = useQueryClient()
  return useCallback(
    (id: ItemId) =>
      queryClient.fetchQuery({
        queryKey: queryKeys.item(model, id),
        queryFn: ({ signal }) => api.objects.get({ params: { model, id }, signal }),
        staleTime: 30_000,
      }),
    [api, model, queryClient],
  )
}

/** Норма недели страницы (`#/<модель>/settings/pages/<страница>`). */
export function useWeekNorm(model: ModelCode, account: AccountCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.weekNorm(model, account),
    queryFn: ({ signal }) => api.plan.norm({ params: { model, account }, signal }),
  })
}

interface NormsState {
  norms: readonly WeekNorm[]
  ready: boolean
}

/** Стабильная функция: `useQueries` пересобирает итог, только когда изменился ответ. */
function combineNorms(results: readonly UseQueryResult<WeekNorm>[]): NormsState {
  return {
    norms: results.flatMap((result) => (result.data ? [result.data] : [])),
    ready: results.every((result) => !result.isPending),
  }
}

/** Нормы всех страниц модели сразу: окно «В план» подставляет по ним время и страницы. */
export function useWeekNorms(model: ModelCode, accounts: readonly AccountCode[]): NormsState {
  const api = useApi()
  return useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.weekNorm(model, account),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.plan.norm({ params: { model, account }, signal }),
    })),
    combine: combineNorms,
  })
}

/**
 * Строка проверки окна «В план» (DESIGN §4.13): тот же `rows:check`, что у агента.
 * По строке на каждую будущую строку плана; ответы кэшируются по составу строки.
 */
export function useRowChecks(model: ModelCode, rows: readonly NewPlanRow[]) {
  const api = useApi()
  return useQueries({
    queries: rows.map((row) => ({
      queryKey: [...queryKeys.model(model), 'plan-check', row] as const,
      queryFn: () => api.plan.checkRow({ params: { model }, body: row }),
      staleTime: 10_000,
    })),
  })
}

/** Предпросмотр пакета («Поставить 14»): `POST rows?dry_run=1`, ничего не создаёт. */
export function usePlanPreview(model: ModelCode, rows: readonly NewPlanRow[]) {
  const api = useApi()
  return useQuery({
    queryKey: [...queryKeys.model(model), 'plan-preview', rows] as const,
    queryFn: () =>
      api.plan.createRows({
        params: { model },
        query: { dry_run: true },
        body: { rows: [...rows] },
      }),
    enabled: rows.length > 0,
    staleTime: 10_000,
  })
}

/** Всё, что меняется после команды над планом: день, неделя, счётчики, сводка страниц. */
export function planChangedKeys(model: ModelCode): readonly QueryKey[] {
  return [
    [...queryKeys.model(model), 'plan-day'],
    [...queryKeys.model(model), 'plan-week'],
    [...queryKeys.model(model), 'plan-row'],
    queryKeys.pageSummaries(model),
    [...queryKeys.model(model), 'not-uploaded'],
    [...queryKeys.model(model), 'check'],
    queryKeys.counters(),
  ]
}

interface Call {
  /** Ключ повтора намерения (DESIGN §3.8). */
  key: string
}

interface RowCall extends Call {
  row: string
}

interface VersionedRowCall extends RowCall {
  /** Версия, от которой идёт правка: `If-Match`. */
  version: number
}

/**
 * Команды плана поверх клиента API. Ключ повтора приходит от намерения человека:
 * новое нажатие — новый ключ, «Повторить» — прежний.
 */
export function usePlanCommands(model: ModelCode) {
  const api = useApi()
  return useMemo(
    () => ({
      createRows: ({ key, rows }: Call & { rows: readonly NewPlanRow[] }) =>
        api.plan.createRows({
          params: { model },
          body: { rows: [...rows] },
          idempotencyKey: key,
        }),
      undoCreate: ({ key, row }: RowCall) =>
        api.plan.undoCreate({ params: { model, row }, idempotencyKey: key }),
      createRelease: ({ key, command }: Call & { command: CreateReleaseCommand }) =>
        api.plan.createRelease({ params: { model }, body: command, idempotencyKey: key }),
      mark: ({ key, row, kind, at }: RowCall & { kind: MarkKind; at: string | null }) =>
        api.plan.mark({
          params: { model, row },
          body: { kind, stated_occurred_at: at },
          idempotencyKey: key,
        }),
      markConfirm: ({ key, row, at }: RowCall & { at: string | null }) =>
        api.plan.markConfirm({
          params: { model, row },
          body: { stated_occurred_at: at },
          idempotencyKey: key,
        }),
      markMany: ({ key, rows, kind }: Call & { rows: readonly string[]; kind: MarkKind }) =>
        api.plan.markMany({
          params: { model },
          body: { row_ids: [...rows], kind },
          idempotencyKey: key,
        }),
      markConfirmMany: ({ key, rows }: Call & { rows: readonly string[] }) =>
        api.plan.markConfirmMany({
          params: { model },
          body: { row_ids: [...rows] },
          idempotencyKey: key,
        }),
      unmark: ({ key, row }: RowCall) =>
        api.plan.unmark({ params: { model, row }, idempotencyKey: key }),
      cancel: ({ key, row, reason }: RowCall & { reason: CancelReason | null }) =>
        api.plan.cancel({ params: { model, row }, body: { reason }, idempotencyKey: key }),
      move: ({ key, row, version, target }: VersionedRowCall & { target: MoveRowCommand }) =>
        api.plan.move({
          params: { model, row },
          body: target,
          ifMatch: version,
          idempotencyKey: key,
        }),
      update: ({ key, row, version, change }: VersionedRowCall & { change: UpdateRowCommand }) =>
        api.plan.updateRow({
          params: { model, row },
          body: change,
          ifMatch: version,
          idempotencyKey: key,
        }),
      download: ({ key, command }: Call & { command: PlanDownloadCommand }) =>
        api.plan.download({ params: { model }, body: command, idempotencyKey: key }),
      /** Файл строки плана: имя с кодом страницы, днём и временем строки (§2.5). */
      downloadRow: ({
        key,
        item,
        row,
        account,
        kind,
        stripMetadata,
      }: Call & {
        item: string
        row: string
        account: AccountCode
        kind: DownloadKind
        stripMetadata: boolean
      }) =>
        api.objects.download({
          params: { model, id: item },
          body: { kind, strip_metadata: stripMetadata, account, plan_row: row },
          idempotencyKey: key,
        }),
      updateNorm: ({
        key,
        account,
        version,
        norm,
      }: Call & { account: AccountCode; version: number; norm: UpdateWeekNormCommand }) =>
        api.plan.updateNorm({
          params: { model, account },
          body: norm,
          ifMatch: version,
          idempotencyKey: key,
        }),
      confirmPair: ({ key, checkCase }: Call & { checkCase: string }) =>
        api.check.confirmPair({
          params: { model, case: checkCase },
          body: { evidence_id: null },
          idempotencyKey: key,
        }),
      undoPair: ({ key, checkCase }: Call & { checkCase: string }) =>
        api.check.undo({ params: { model, case: checkCase }, idempotencyKey: key }),
      rejectPair: ({ key, checkCase }: Call & { checkCase: string }) =>
        api.check.reject({
          params: { model, case: checkCase },
          body: { evidence_id: null },
          idempotencyKey: key,
        }),
    }),
    [api, model],
  )
}

export type PlanCommands = ReturnType<typeof usePlanCommands>
