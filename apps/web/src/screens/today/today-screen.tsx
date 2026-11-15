import {
  addDays,
  formatDate,
  formatLongDay,
  isoWeekOf,
  mskDate,
  plural,
  SURFACE_LABEL,
} from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import { useHubOrderList } from '@/data/hub-orders'
import { useInboxList } from '@/data/inbox'
import { usePlanDay, usePlanWeek } from '@/data/plan'
import { useRole, useSession } from '@/data/session'
import { useWaiting } from '@/data/waiting'
import { FieldLayout } from '@/shell/field/field-layout'
import { useCurrentModel } from '@/shell/model/model-context'
import { WaitingLines } from '../waiting/waiting-lines'
import { FirstDayCard } from './first-day'
import { Quiet, TodayBlock, TodayLine } from './today-block'

/**
 * «Сегодня» `/<модель>/today` (план продуктов §2.4) — дом: что выходит сегодня по страницам, дыры
 * плана на 7 дней, что приехало, кастомы в съёмке и первые строки «Ждут вас». Каждый блок ведёт
 * на свой экран; числа — те же чтения, что у этих экранов.
 */
export function TodayScreen() {
  const model = useCurrentModel()
  const role = useRole()
  const session = useSession().data
  const href = useHref()
  const now = useClock().now()
  const today = mskDate(now)
  const staff = role === 'owner' || role === 'manager'
  const params = { model: model.code }
  const labelOf = (code: string) =>
    model.accounts.find((account) => account.code === code)?.label ?? code

  const day = usePlanDay(model.code, today, { mine: false, cancelled: false })
  const thisWeek = isoWeekOf(today)
  const nextWeek = isoWeekOf(addDays(today, 7))
  const week = usePlanWeek(model.code, thisWeek)
  const following = usePlanWeek(model.code, nextWeek, nextWeek !== thisWeek)
  const inbox = useInboxList(model.code, 'active', role !== 'reader')
  const orders = useHubOrderList(model.code)
  const waiting = useWaiting(model.code, role)

  // «Выходит сегодня» по страницам, в порядке страниц дня.
  const rows = (day.data?.rows ?? []).filter((row) => !row.cancelled)
  const byAccount = (day.data?.groups ?? [])
    .map((group) => ({
      account: group.account,
      rows: rows
        .filter((row) => row.account === group.account)
        .sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99')),
    }))
    .filter((group) => group.rows.length > 0)

  // «Дыры на 7 дней»: пустые места нормы с сегодня по шестой день, по страницам.
  const last = addDays(today, 6)
  const gaps = [...(week.data?.gaps ?? []), ...(following.data?.gaps ?? [])].filter(
    (gap) => gap.date >= today && gap.date <= last,
  )
  const gapsByAccount = new Map<string, number>()
  for (const gap of gaps) gapsByAccount.set(gap.account, (gapsByAccount.get(gap.account) ?? 0) + 1)

  // «Приехало»: новые группы и самая давняя из них.
  const groups = inbox.data?.items ?? []
  const oldest = groups.reduce<string | null>(
    (min, group) => (min === null || group.arrived_at < min ? group.arrived_at : min),
    null,
  )

  // «В съёмке»: заказы Hub у модели по сроку, просроченные первыми.
  const shooting = [...(orders.data?.items ?? [])].sort((a, b) =>
    (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'),
  )

  return (
    <FieldLayout className="overflow-y-auto pb-6">
      <FieldHeader title="Сегодня" meta={`${model.name} · ${formatLongDay(today)}`} />
      <div className="flex flex-col gap-4 pb-2">
        {session?.first_day ? (
          <FirstDayCard model={model.code} today={today} canApprove={staff} />
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <TodayBlock
            title="Выходит сегодня"
            href={href({ to: '/$model/plan/$date', params: { ...params, date: today } })}
            linkLabel="План"
          >
            {day.isPending ? (
              <Quiet>Загружаем план…</Quiet>
            ) : byAccount.length === 0 ? (
              <Quiet>На сегодня в плане ничего</Quiet>
            ) : (
              byAccount.map((group) => (
                <div key={group.account} className="pb-1">
                  <p className="pt-1 font-medium text-sm">{labelOf(group.account)}</p>
                  <ul>
                    {group.rows.map((row) => (
                      <TodayLine
                        key={row.id}
                        main={`${row.time ?? 'весь день'} · ${row.manifest?.title ?? 'ждёт монтажа'} · ${SURFACE_LABEL[row.surface]}`}
                        side={row.verdict.word}
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </TodayBlock>

          <TodayBlock
            title="Ждут вас"
            href={href({ to: '/$model/waiting', params })}
            linkLabel={waiting.total > 0 ? `Все ${waiting.total}` : 'Открыть'}
          >
            {waiting.own.length + waiting.matters.length === 0 ? (
              <Quiet>
                {waiting.hub.data?.hub === 'unreachable' ? 'Hub не ответил' : 'Ничего не ждёт'}
              </Quiet>
            ) : (
              <WaitingLines model={model.code} waiting={waiting} limit={3} />
            )}
          </TodayBlock>

          <TodayBlock
            title="Дыры на 7 дней"
            href={href({ to: '/$model/plan/w/$week', params: { ...params, week: thisWeek } })}
            linkLabel="Неделя"
          >
            {week.isPending ? (
              <Quiet>Загружаем неделю…</Quiet>
            ) : gaps.length === 0 ? (
              <Quiet>По нормам всё заполнено</Quiet>
            ) : (
              <ul>
                {model.accounts
                  .filter((account) => gapsByAccount.has(account.code))
                  .map((account) => [account.code, gapsByAccount.get(account.code) ?? 0] as const)
                  .map(([account, count]) => (
                    <TodayLine
                      key={account}
                      main={labelOf(account)}
                      side={`пусто ${count} ${plural(count, ['место', 'места', 'мест'])}`}
                    />
                  ))}
              </ul>
            )}
          </TodayBlock>

          {role === 'reader' ? null : (
            <TodayBlock
              title={`Приехало: новых ${inbox.data?.count ?? 0}`}
              href={href({ to: '/$model/inbox', params })}
              linkLabel="Приехало"
            >
              {inbox.isPending ? (
                <Quiet>Загружаем…</Quiet>
              ) : groups.length === 0 ? (
                <Quiet>Всё разобрано</Quiet>
              ) : (
                <ul>
                  <TodayLine
                    main="Нужно решение"
                    side={String(inbox.data?.sections?.decision ?? 0)}
                  />
                  <TodayLine
                    main="Готово к приёмке"
                    side={String(inbox.data?.sections?.ready ?? 0)}
                  />
                  {oldest ? (
                    <TodayLine
                      main="Самое давнее ждёт с"
                      side={formatDate(mskDate(oldest), today)}
                    />
                  ) : null}
                </ul>
              )}
            </TodayBlock>
          )}

          <TodayBlock
            title="В съёмке"
            href={href({ to: '/$model/library/customs', params, search: { view: 'orders' } })}
            linkLabel="Заказы"
          >
            {orders.isPending ? (
              <Quiet>Загружаем заказы Hub…</Quiet>
            ) : shooting.length === 0 ? (
              <Quiet>
                {orders.data?.configured === false ? 'Hub не подключён' : 'Кастомов в съёмке нет'}
              </Quiet>
            ) : (
              <ul>
                {shooting.slice(0, 6).map((order) => (
                  <TodayLine
                    key={order.code}
                    main={`${order.code} · ${order.title}`}
                    side={
                      order.overdue_days
                        ? `просрочен ${order.overdue_days} ${plural(order.overdue_days, ['день', 'дня', 'дней'])}`
                        : order.deadline
                          ? `до ${formatDate(order.deadline, today)}`
                          : order.status.word
                    }
                  />
                ))}
              </ul>
            )}
          </TodayBlock>
        </div>
      </div>
    </FieldLayout>
  )
}
