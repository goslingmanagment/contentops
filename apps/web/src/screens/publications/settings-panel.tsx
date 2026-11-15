import type { PublicationPage } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Input } from '@contentops/ui/components/input'
import { PanelFrame, type PanelFrameWidth } from '@contentops/ui/components/panel-frame'
import { Switch } from '@contentops/ui/components/switch'
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useApi } from '@/data/api-session'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'
import type { PublicationActions } from './use-publication-actions'
import { formatMills } from './words'

const SWITCHES = [
  {
    key: 'publishingEnabled',
    title: 'Публикация постов через Hub',
    hint: 'Общий выключатель всех страниц',
  },
  {
    key: 'publishingOnlyfansEnabled',
    title: 'Публикация на OnlyFans',
    hint: 'Вместе с общим и выключателем страницы',
  },
  {
    key: 'publishingOnlyfansVaultEnabled',
    title: 'Альбомы медиатеки OnlyFans',
    hint: 'Заливка утверждённых альбомов',
  },
] as const

/**
 * «Настройки публикации» (пакет C2): что публикует Hub и на каких страницах модели. Владелец меняет выключатели и
 * настройки страницы, читает расписание заново и убирает всё, что поставил Hub; контент-менеджер видит и читает
 * расписание. Всё делает Hub от имени человека.
 */
export function SettingsPanel({
  pages,
  width,
  className,
  actions,
  onClose,
}: {
  pages: readonly PublicationPage[]
  width: PanelFrameWidth
  className?: string
  actions: PublicationActions
  onClose: () => void
}) {
  const model = useCurrentModel()
  const api = useApi()
  const owner = useRole() === 'owner'
  const switches = useQuery({
    queryKey: ['model', model.code, 'publication-switches'],
    queryFn: ({ signal }) => api.publications.switches({ params: { model: model.code }, signal }),
  })
  const switchOf = (key: string) => switches.data?.switches.find((one) => one.key === key)
  return (
    <PanelFrame
      label="Настройки публикации"
      title="Настройки публикации"
      width={width}
      onClose={onClose}
      className={className}
    >
      <div className="flex flex-col gap-5 pb-6">
        <InfoSection title="Выключатели">
          <ul className="flex flex-col gap-3">
            {SWITCHES.map((one) => {
              const found = switchOf(one.key)
              const on = found?.value === true || found?.value === 'true'
              return (
                <li key={one.key} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm">{one.title}</span>
                    <span className="text-muted-foreground text-xs">{one.hint}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-sm">
                    {found ? (on ? 'Включена' : 'Выключена') : '…'}
                    <Switch
                      checked={on}
                      disabled={!owner || !found || actions.switchSet.isPending}
                      aria-label={one.title}
                      onCheckedChange={(next) =>
                        actions.switchSet.start({
                          key: one.key,
                          value: next,
                          version: found?.version ?? null,
                        })
                      }
                    />
                  </span>
                </li>
              )
            })}
          </ul>
          {switches.data?.ofapi === false ? (
            <p className="pt-2 text-attention-ink text-sm">
              OnlyFans API выключен: страницы OnlyFans не публикуют.
            </p>
          ) : null}
        </InfoSection>
        <InfoSection title="Страницы">
          {pages.length === 0 ? <p className="text-muted-foreground text-sm">Страниц нет</p> : null}
          <ul className="flex flex-col gap-4">
            {pages.map((page) => (
              <PageRow key={page.hub_page} page={page} owner={owner} actions={actions} />
            ))}
          </ul>
          {owner ? null : (
            <p className="pt-2 text-muted-foreground text-sm">Настройки меняет владелец.</p>
          )}
        </InfoSection>
      </div>
    </PanelFrame>
  )
}

function PageRow({
  page,
  owner,
  actions,
}: {
  page: PublicationPage
  owner: boolean
  actions: PublicationActions
}) {
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const range =
    page.paid_price_min_mills !== null && page.paid_price_max_mills !== null
      ? `${formatMills(page.paid_price_min_mills)}–${formatMills(page.paid_price_max_mills)}`
      : 'вилка не задана'
  return (
    <li className="flex flex-col gap-1.5 border-border border-b pb-4 last:border-b-0">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm">
          {page.label}{' '}
          <span className="text-muted-foreground">
            {page.platform === 'onlyfans' ? 'OnlyFans' : 'Fansly'}
          </span>
        </span>
        <span className="text-sm">
          {page.stopped ? 'Остановлена' : page.enabled ? 'Публикует' : 'Не публикует'}
        </span>
      </span>
      <span className="text-muted-foreground text-sm">
        Платные посты {range} ·{' '}
        {page.daily_limit === null
          ? 'без предела в сутки'
          : `не больше ${page.daily_limit} в сутки`}{' '}
        · повтор файла через {page.repost_threshold_days} дн.
      </span>
      {page.stopped ? (
        <span className="text-destructive text-sm">
          Hub остановил: {page.stopped_words ?? 'причина записана кодом'}
        </span>
      ) : null}
      {page.queue ? (
        <span className="text-muted-foreground text-sm">
          {page.queue.read_at ? 'Расписание прочитано' : 'Расписание ещё не прочитано'}
          {page.queue.last_failure ? ' · последнее чтение не удалось' : ''}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-2 pt-1">
        {page.platform === 'fansly' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={actions.page.isPending}
            onClick={() => actions.page.start({ page: page.hub_page, verb: 'refreshPage' })}
          >
            Прочитать расписание заново
          </Button>
        ) : null}
        {owner ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing((open) => !open)}>
              Изменить
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
              Убрать всё
            </Button>
          </>
        ) : null}
      </span>
      {confirm ? (
        <span className="flex flex-col gap-2 pt-1">
          <span className="text-sm">
            Из расписания площадки уйдёт всё, что поставлено на {page.label}.
          </span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                actions.page.start({ page: page.hub_page, verb: 'withdrawPage' })
                setConfirm(false)
              }}
            >
              Убрать всё
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirm(false)}>
              Не надо
            </Button>
          </span>
        </span>
      ) : null}
      {editing ? (
        <SettingsForm page={page} actions={actions} onDone={() => setEditing(false)} />
      ) : null}
    </li>
  )
}

function SettingsForm({
  page,
  actions,
  onDone,
}: {
  page: PublicationPage
  actions: PublicationActions
  onDone: () => void
}) {
  const id = useId()
  const [enabled, setEnabled] = useState(page.enabled)
  const [min, setMin] = useState(
    page.paid_price_min_mills === null ? '' : String(page.paid_price_min_mills / 1000),
  )
  const [max, setMax] = useState(
    page.paid_price_max_mills === null ? '' : String(page.paid_price_max_mills / 1000),
  )
  const [repost, setRepost] = useState(String(page.repost_threshold_days))
  const [limit, setLimit] = useState(page.daily_limit === null ? '' : String(page.daily_limit))
  const mills = (text: string) =>
    text.trim() === '' ? null : Math.round(Number(text.replace(',', '.')) * 1000)
  return (
    <form
      className="flex flex-col gap-2 pt-2"
      onSubmit={(event) => {
        event.preventDefault()
        actions.settings.start({
          page: page.hub_page,
          body: {
            enabled,
            paid_price_min_mills: mills(min),
            paid_price_max_mills: mills(max),
            repost_threshold_days: Number(repost) || 0,
            daily_limit: limit.trim() === '' ? null : Number(limit),
          },
        })
        onDone()
      }}
    >
      <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-on`}>
        <Switch id={`${id}-on`} checked={enabled} onCheckedChange={setEnabled} /> Публикует
      </label>
      <span className="grid grid-cols-2 gap-2">
        <span className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-min`}>Платный от, $</label>
          <Input
            id={`${id}-min`}
            value={min}
            onChange={(event) => setMin(event.target.value)}
            inputMode="decimal"
          />
        </span>
        <span className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-max`}>до, $</label>
          <Input
            id={`${id}-max`}
            value={max}
            onChange={(event) => setMax(event.target.value)}
            inputMode="decimal"
          />
        </span>
        <span className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-repost`}>Повтор файла через, дней</label>
          <Input
            id={`${id}-repost`}
            value={repost}
            onChange={(event) => setRepost(event.target.value)}
            inputMode="numeric"
          />
        </span>
        <span className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-limit`}>В сутки не больше</label>
          <Input
            id={`${id}-limit`}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            inputMode="numeric"
          />
        </span>
      </span>
      <span className="flex gap-2">
        <Button type="submit" size="sm" disabled={actions.settings.isPending}>
          Сохранить
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Отмена
        </Button>
      </span>
    </form>
  )
}
