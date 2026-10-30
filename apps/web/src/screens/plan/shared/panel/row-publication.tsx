import {
  formatStamp,
  type PlanRow,
  PUBLICATION_STATE_WORD,
  type PublicationState,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Input } from '@contentops/ui/components/input'
import { Label } from '@contentops/ui/components/label'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Textarea } from '@contentops/ui/components/textarea'
import { useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useClock } from '@/data/api-session'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { useCurrentModel } from '@/shell/model/model-context'
import { usePublishActions } from '../actions/use-publish-actions'
import { CheckLines } from '../publish-controls'

/**
 * «Публикация через Hub» в панели строки (DESIGN §4.11, §5.2; SPEC §7): состояние публикации,
 * проверки Hub (предупреждения янтарём, блокирующая — причина словами), файлы черновика,
 * поля публикации, свежесть статусов («Hub · статусы на 18:32») и отмена своей публикации,
 * пока Hub не поставил её в расписание площадки. Главная кнопка — наверху панели.
 */

const STATE_SIGN: Partial<Record<PublicationState, 'done' | 'trouble'>> = {
  published: 'done',
  not_published: 'trouble',
}

const PENDING_TEXT = {
  prepare: 'Hub готовит черновик: загружает файлы и проверяет',
  send: 'Отправляется в Hub',
  cancel: 'Публикация отменяется',
} as const

export function RowPublication({ row, canAct }: { row: PlanRow; canAct: boolean }) {
  const clock = useClock()
  const publish = usePublishActions()
  const [editing, setEditing] = useState(false)
  const hub = row.hub
  if (!hub) {
    return null
  }
  const publication = hub.publication
  const sent =
    publication !== null && !['draft', 'cancelled', 'not_published'].includes(publication.state)
  return (
    <InfoSection
      title="Публикация через Hub"
      aside={
        publication ? (
          <StatusWord sign={STATE_SIGN[publication.state]}>
            {PUBLICATION_STATE_WORD[publication.state]}
          </StatusWord>
        ) : (
          <StatusWord>{hub.enabled ? 'не готовили' : 'выключена'}</StatusWord>
        )
      }
    >
      <div className="flex flex-col gap-2 text-base">
        {hub.manual ? <p className="text-ink-3">{hub.manual}</p> : null}
        {!hub.enabled ? (
          <p className="text-ink-3">
            Публикация через Hub выключена для страницы — строку выкладывают руками.
          </p>
        ) : null}
        {publication ? <p>{publication.text}</p> : null}
        {hub.pending ? <p className="text-ink-3">{PENDING_TEXT[hub.pending]}…</p> : null}
        {hub.error ? (
          <p role="alert" className="flex items-start gap-1.5 text-destructive text-sm">
            <StatusSign kind="trouble" size={14} className="mt-0.5" />
            <span>{hub.error}</span>
          </p>
        ) : null}
        {publication?.stale ? (
          <p className="flex items-start gap-1.5 text-attention-ink text-sm">
            <StatusSign kind="turn" size={14} className="mt-0.5" />
            <span>Строку изменили после «Подготовить» — подготовьте заново</span>
          </p>
        ) : null}
        {publication && publication.checks.length > 0 ? (
          <CheckLines checks={publication.checks} />
        ) : publication?.state === 'draft' ? (
          <p className="text-ink-3 text-sm">Проверки Hub прошли.</p>
        ) : null}
        {publication && publication.files.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-sm">
            {publication.files.map((file) => (
              <li key={file.name} className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-mono text-xs" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-ink-3">
                  {file.source === 'vault' ? 'уже в vault' : 'в Hub'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {editing ? (
          <FieldsForm row={row} onDone={() => setEditing(false)} />
        ) : (
          <FieldsLine
            row={row}
            onEdit={canAct && hub.enabled && !sent ? () => setEditing(true) : null}
          />
        )}
        {hub.statuses_at ? (
          <p className="text-ink-3 text-sm">
            Hub · статусы на {formatStamp(hub.statuses_at, clock.now())}
          </p>
        ) : null}
        {canAct && hub.can_cancel ? (
          <Button
            variant="link"
            size="inline"
            className="self-start text-sm"
            pending={publish.cancelling}
            onClick={() => publish.cancel(row)}
          >
            Отменить публикацию
          </Button>
        ) : null}
      </div>
    </InfoSection>
  )
}

function dollars(mills: number): string {
  return `$${(mills / 1000).toFixed(2).replace(/\.00$/, '')}`
}

/** «Подпись · все подписчики · $12 · повтор». */
function FieldsLine({ row, onEdit }: { row: PlanRow; onEdit: (() => void) | null }) {
  const fields = row.publication
  const parts: string[] = []
  if (row.surface === 'vault') {
    parts.push(`альбом «${row.album ?? ''}»`)
  } else {
    parts.push(fields.caption ? `подпись «${fields.caption}»` : 'без подписи')
    parts.push(
      fields.tiers && fields.tiers.length > 0 ? `тиры: ${fields.tiers.length}` : 'все подписчики',
    )
  }
  if (fields.price_mills) {
    parts.push(dollars(fields.price_mills))
  }
  if (fields.repost) {
    parts.push('повтор')
  }
  return (
    <p className="text-ink-3 text-sm">
      {parts.join(' · ')}
      {onEdit ? (
        <>
          {' · '}
          <Button variant="link" size="inline" onClick={onEdit}>
            Изменить
          </Button>
        </>
      ) : null}
    </p>
  )
}

/** Поля публикации (SPEC §4): подпись или имя альбома, цена, «повтор»; с версией записи. */
function FieldsForm({ row, onDone }: { row: PlanRow; onDone: () => void }) {
  const model = useCurrentModel().code
  const commands = usePlanCommands(model)
  const toast = useActionToast()
  const captionId = useId()
  const priceId = useId()
  const repostId = useId()
  const vault = row.surface === 'vault'
  const [text, setText] = useState((vault ? row.album : row.publication.caption) ?? '')
  const [price, setPrice] = useState(
    row.publication.price_mills ? String(row.publication.price_mills / 1000) : '',
  )
  const [repost, setRepost] = useState(row.publication.repost)
  const save = useVersionedSave({
    run: (change: Record<string, unknown>, version: number, key: string) =>
      commands.update({ key, row: row.id, version, change }),
    failed: 'Не сохранилось',
    subject: 'поля публикации',
    invalidates: planChangedKeys(model),
    onSuccess: () => {
      toast.show({ message: 'Сохранено · подготовьте заново' })
      onDone()
    },
  })
  const parsed = price.trim() === '' ? null : Math.round(Number(price.replace(',', '.')) * 1000)
  const change = () => ({
    ...(vault ? { album: text.trim() || null } : { caption: text.trim() || null }),
    ...(vault ? {} : { price_mills: parsed }),
    repost,
  })
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        save.save(change(), row.version)
      }}
    >
      {save.conflict ? (
        <ConflictLine
          message={save.conflict.message}
          theirsLabel={save.conflict.theirsLabel}
          onShowTheirs={() => {
            save.showTheirs()
            onDone()
          }}
          onKeepMine={() => save.keepMine(change())}
        />
      ) : null}
      <Label htmlFor={captionId} className="text-ink-3 text-sm">
        {vault ? 'Альбом vault' : 'Подпись'}
      </Label>
      {vault ? (
        <Input id={captionId} value={text} onChange={(event) => setText(event.target.value)} />
      ) : (
        <Textarea id={captionId} value={text} onChange={(event) => setText(event.target.value)} />
      )}
      {vault ? null : (
        <div className="flex items-center gap-3">
          <Label htmlFor={priceId} className="w-20 text-ink-3 text-sm">
            Цена, $
          </Label>
          <Input
            id={priceId}
            inputMode="decimal"
            value={price}
            placeholder="без цены"
            onChange={(event) => setPrice(event.target.value)}
            className="w-28"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Checkbox
          id={repostId}
          checked={repost}
          onCheckedChange={(checked) => setRepost(checked === true)}
        />
        <Label htmlFor={repostId} className="text-sm">
          Повтор — файл выходит снова намеренно
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          pending={save.isPending}
          disabled={parsed !== null && (Number.isNaN(parsed) || parsed < 0)}
        >
          Сохранить
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
