import { isoWeekOf, type LocalDate } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { useQueryClient } from '@tanstack/react-query'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useHref } from '@/app/use-href'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

/**
 * «Первый день» (план продуктов §2.4): пять дел контент-менеджера здесь и где они. Закрывает сам
 * человек, больше не показывается.
 */
export function FirstDayCard({
  model,
  today,
  canApprove,
}: {
  model: string
  today: LocalDate
  canApprove: boolean
}) {
  const href = useHref()
  const api = useApi()
  const queryClient = useQueryClient()
  const close = useIntentMutation<undefined, unknown>({
    failed: 'Не закрылось',
    run: (_body, key) => api.settings.closeFirstDay({ idempotencyKey: key }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.session() }),
  })
  const params = { model }
  const steps = [
    {
      title: 'Принять',
      where: 'Приехало',
      text: 'что прислала модель: тип, название, в библиотеку',
      to: href({ to: '/$model/inbox', params }),
    },
    {
      title: 'Поставить',
      where: 'План',
      text: 'посты по страницам на дни недели',
      to: href({ to: '/$model/plan/$date', params: { model, date: today } }),
    },
    {
      title: 'Сверить и утвердить неделю',
      where: 'План',
      text: canApprove
        ? 'что вышло с тем, что стояло в плане; бесплатные посты утверждённой недели выложит агент'
        : 'что вышло с тем, что стояло в плане; неделю утверждает владелец или КМ модели',
      to: href({ to: '/$model/plan/w/$week', params: { model, week: isoWeekOf(today) } }),
    },
    {
      title: 'Публикации',
      where: 'Публикации',
      text: 'что ждёт утверждения и что вышло',
      to: href({ to: '/$model/publications', params }),
    },
    {
      title: 'Съёмка',
      where: 'Съёмка',
      text: 'кастомы у модели: сроки и файлы',
      to: href({ to: '/$model/shooting', params }),
    },
  ]
  return (
    <section className="rounded-2xl bg-muted p-4" aria-label="Первый день">
      <div className="flex items-start gap-3 pb-2">
        <h2 className="min-w-0 flex-1 font-medium text-md">Первый день: что вы делаете здесь</h2>
        <Button size="sm" variant="ghost" onClick={() => close.start(undefined)}>
          Понятно, скрыть
        </Button>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((step, index) => (
          <li key={step.title}>
            <a href={step.to} className="block rounded-xl bg-background p-3 hover:text-primary">
              <span className="block font-medium text-sm">
                {index + 1}. {step.title}
              </span>
              <span className="block text-muted-foreground text-sm">
                «{step.where}»: {step.text}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}
