import {
  formatClock,
  formatDateWords,
  isApiError,
  mskDate,
  type PublicationRow,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import {
  PanelFrame,
  type PanelFrameWidth,
  PanelMessage,
} from '@contentops/ui/components/panel-frame'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { StatusWord } from '@contentops/ui/components/status-word'
import { UiLink } from '@contentops/ui/components/ui-link'
import { type ReactNode, useState } from 'react'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { usePublicationCard } from '@/data/publications'
import { useRole } from '@/data/session'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import type { PublicationActions } from './use-publication-actions'
import { findingWord, formatMills, hubStateWords, KIND_WORDS, statusWord } from './words'

interface PublicationPanelProps {
  id: number
  actions: PublicationActions
  width: PanelFrameWidth
  onClose: () => void
  /** На телефоне карточка занимает всё поле. */
  className?: string
}

const ACTOR_WORDS = { human: 'человек', agent: 'агент', hub: 'система' } as const

/**
 * Карточка поста (пакет C2): что, где, когда, файлы, проверки Hub, ответ площадки и журнал статусов. Пост
 * подготовлен в плане — ссылка на его день плана. Действия появятся следующим шагом пакета.
 */
export function PublicationPanel({
  id,
  width,
  onClose,
  className,
  actions,
}: PublicationPanelProps) {
  const model = useCurrentModel()
  const query = usePublicationCard(model.code, id)
  const today = useToday()
  const href = useHref()
  if (isApiError(query.error) && query.error.status === 404) {
    return (
      <PanelMessage label="Пост" width={width} onClose={onClose}>
        Поста №{id} на страницах {model.name_genitive} нет
      </PanelMessage>
    )
  }
  const card = query.data
  const row = card?.publication ?? null
  if (!card || !row) {
    const words = card ? hubStateWords(card.hub) : null
    return (
      <PanelFrame
        label="Пост"
        title={`Пост №${id}`}
        width={width}
        onClose={onClose}
        className={className}
      >
        {words ? <p className="text-muted-foreground text-sm">{words}</p> : null}
        {query.isError ? (
          <ErrorLine message="Не загрузилось" onRetry={() => void query.refetch()} />
        ) : null}
        {!card && !query.isError ? (
          <div aria-hidden className="flex flex-col gap-3">
            <Skeleton className="h-18 rounded-xl" />
            <Skeleton className="h-4 w-48 rounded-sm" />
          </div>
        ) : null}
      </PanelFrame>
    )
  }
  const status = statusWord(row.status, row.status_reason)
  const media = row.files
    .filter((file) => file.role === 'media')
    .sort((a, b) => a.position - b.position)
  const previews = row.files
    .filter((file) => file.role === 'preview')
    .sort((a, b) => a.position - b.position)
  const day = mskDate(row.publish_at)
  return (
    <PanelFrame
      label="Пост"
      title={`${accountLabel(model.accounts, row.account ?? row.hub_page)} · ${formatDateWords(day, today)}, ${formatClock(row.publish_at)}`}
      subtitle={
        <StatusWord sign={status.sign} className="max-w-full">
          {status.word}
        </StatusWord>
      }
      width={width}
      onClose={onClose}
      className={className}
      actions={<PostActions row={row} actions={actions} />}
    >
      <div className="flex flex-col gap-5 pb-6">
        {row.blocked ? (
          <p className="rounded-lg bg-destructive-bg px-3 py-2 text-destructive text-sm">
            Нельзя утвердить: замечания ниже не дают выпустить пост.
          </p>
        ) : null}
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          <Line term="Страница">{accountLabel(model.accounts, row.account ?? row.hub_page)}</Line>
          <Line term="Что">{KIND_WORDS[row.kind] ?? row.kind}</Line>
          <Line term="Выход">
            {formatDateWords(day, today)}, {formatClock(row.publish_at)}
          </Line>
          {row.expires_at ? (
            <Line term="На стене до">
              {formatDateWords(mskDate(row.expires_at), today)}, {formatClock(row.expires_at)}
            </Line>
          ) : null}
          {row.price_mills !== null ? (
            <Line term="Цена">{formatMills(row.price_mills)}</Line>
          ) : null}
          <Line term="Автор">{ACTOR_WORDS[row.author]}</Line>
          {card.approved_at ? (
            <Line term="Утверждён">
              {formatDateWords(mskDate(card.approved_at), today)}, {formatClock(card.approved_at)}
            </Line>
          ) : null}
          {row.platform_post_ref ? (
            <Line term="Пост на площадке">№ {row.platform_post_ref}</Line>
          ) : null}
          {/* Hub's words for the people only; its codes stay behind. */}
          {row.status_reason && /[а-яё ]/i.test(row.status_reason) ? (
            <Line term="Ответ">{row.status_reason}</Line>
          ) : null}
          {row.withdrawal ? <Line term="Снятие">{row.withdrawal}</Line> : null}
          {row.deletion ? <Line term="Удаление">{row.deletion}</Line> : null}
          {row.plan_row ? (
            <Line term="План">
              <UiLink
                href={href({
                  to: '/$model/plan/$date',
                  params: { model: model.code, date: row.plan_row.date },
                })}
                className="underline-offset-4 hover:underline"
              >
                подготовлен в плане {formatDateWords(row.plan_row.date, today)}
              </UiLink>
            </Line>
          ) : null}
        </dl>
        <InfoSection title="Текст">
          <p className="whitespace-pre-wrap text-sm">{row.text || 'Без текста'}</p>
        </InfoSection>
        <InfoSection title="Файлы">
          {media.length === 0 ? (
            <p className="text-muted-foreground text-sm">Без файлов</p>
          ) : (
            <ol className="flex flex-col gap-1 text-sm">
              {media.map((file) => (
                <li key={`m${file.position}`}>
                  {file.position + 1}.{' '}
                  {file.name ?? (file.source === 'vault' ? 'из медиатеки' : 'загруженный файл')}
                </li>
              ))}
            </ol>
          )}
          {previews.length > 0 ? (
            <p className="pt-1 text-muted-foreground text-sm">Превью: {previews.length}</p>
          ) : null}
        </InfoSection>
        {row.findings.length > 0 ? (
          <InfoSection title="Замечания">
            <ul className="flex flex-col gap-1 text-sm">
              {row.findings.map((finding, index) => (
                <li
                  key={`${finding.code}-${index}`}
                  className={finding.severity === 'blocking' ? 'text-destructive' : ''}
                >
                  {finding.severity === 'blocking' ? 'Нельзя утвердить: ' : ''}
                  {findingWord(finding.code)}
                </li>
              ))}
            </ul>
          </InfoSection>
        ) : null}
        {card.events.length > 0 ? (
          <InfoSection title="Журнал статусов">
            <ul className="flex flex-col gap-1 text-sm">
              {card.events.map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex gap-3">
                  <span className="w-28 shrink-0 text-muted-foreground tabular-nums">
                    {formatDateWords(mskDate(event.at), today)}, {formatClock(event.at)}
                  </span>
                  <span>
                    {statusWord(event.to, event.reason).word} · {ACTOR_WORDS[event.actor]}
                  </span>
                </li>
              ))}
            </ul>
          </InfoSection>
        ) : null}
      </div>
    </PanelFrame>
  )
}

function Line({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/** What may be done with a post now, by its state; Hub decides the rest and says so. */
function PostActions({ row, actions }: { row: PublicationRow; actions: PublicationActions }) {
  const role = useRole()
  const [confirm, setConfirm] = useState<'withdraw' | 'deletePost' | null>(null)
  const busy = actions.approve.isPending || actions.post.isPending || actions.resolve.isPending
  const buttons: ReactNode[] = []
  if (row.status === 'draft') {
    buttons.push(
      <Button
        key="approve"
        disabled={busy || row.blocked}
        title={row.blocked ? 'Есть замечания, которые не дают утвердить' : undefined}
        onClick={() => actions.approve.start({ id: row.id, version: row.version })}
      >
        Утвердить
      </Button>,
    )
  }
  if (row.status === 'draft' || row.status === 'approved') {
    buttons.push(
      <Button
        key="cancel"
        variant="outline"
        disabled={busy}
        onClick={() => actions.post.start({ id: row.id, verb: 'cancel' })}
      >
        Отменить публикацию
      </Button>,
    )
  }
  if (['submitting', 'scheduled', 'processing'].includes(row.status)) {
    buttons.push(
      <Button
        key="withdraw"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirm('withdraw')}
      >
        Убрать из расписания
      </Button>,
    )
  }
  if (row.status === 'unknown') {
    buttons.push(
      <Button
        key="went"
        disabled={busy}
        onClick={() => actions.resolve.start({ id: row.id, answer: { outcome: 'went_out' } })}
      >
        Вышел
      </Button>,
      <Button
        key="not"
        variant="outline"
        disabled={busy}
        onClick={() => actions.resolve.start({ id: row.id, answer: { outcome: 'did_not_go_out' } })}
      >
        Не вышел
      </Button>,
    )
  }
  if (row.status === 'withdrawn' && row.status_reason !== 'deleted_after_publish') {
    buttons.push(
      <Button
        key="replace"
        variant="outline"
        disabled={busy}
        onClick={() => actions.post.start({ id: row.id, verb: 'replace' })}
      >
        Заменить
      </Button>,
    )
  }
  // Deleting a live post from the wall is the owner's alone (Hub refuses anyone else).
  if (role === 'owner' && row.status === 'published' && row.platform === 'fansly') {
    buttons.push(
      <Button
        key="delete"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirm('deletePost')}
      >
        Удалить со стены
      </Button>,
    )
  }
  if (confirm) {
    return (
      <div className="flex flex-col gap-2 pb-3">
        <p className="text-sm">
          {confirm === 'withdraw'
            ? 'Пост уйдёт из расписания площадки. Команда уходит один раз.'
            : 'Пост будет удалён со стены. Его увидят только те, кто уже открыл.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              actions.post.start({ id: row.id, verb: confirm })
              setConfirm(null)
            }}
          >
            {confirm === 'withdraw' ? 'Убрать' : 'Удалить'}
          </Button>
          <Button variant="outline" onClick={() => setConfirm(null)}>
            Не надо
          </Button>
        </div>
      </div>
    )
  }
  if (buttons.length === 0) return null
  return <div className="flex flex-wrap gap-2 pb-3">{buttons}</div>
}
