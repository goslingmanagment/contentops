import {
  FAN_NAME_LABEL,
  type FrameCheck,
  formatNumber,
  formatWhen,
  type ItemDetail,
  type ItemId,
  plural,
  type SaveFrameCheckCommand,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi, useClock } from '@/data/api-session'
import { markupReviewKey } from '@/data/catalog'
import { useItem, useItemWriter } from '@/data/object'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'
import {
  initialBlocked,
  isWholeVideo,
  type SheetCheck,
  type SheetFrame,
  sheetCheckOf,
  sheetFramesOf,
  sheetVersionOf,
} from './frame-sheet-model'

const SKELETON_FRAMES = 10
/** Десять кадров мастера встают в один ряд; фото секстинга переносятся и листаются. */
const FRAME_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2'

function framesWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['кадр', 'кадра', 'кадров'])}`
}

const VERDICT_WORD: Record<FrameCheck['verdict'], string> = {
  send: 'Можно отправлять',
  hold: 'Не отправлять',
}

interface FrameSheetProps {
  id: ItemId
  onClose: () => void
}

/**
 * Лист кадров перед отправкой фану (DESIGN §4.20, «Посмотреть кадры»): кадры мастера
 * сеткой, у каждого «Не отправлять этот кадр», внизу итог «Можно отправлять» /
 * «Не отправлять» и серым «проверено для v2». Проверка прежней версии после правки не
 * считается: кадры смотрят заново.
 */
export function FrameSheet({ id, onClose }: FrameSheetProps) {
  const model = useCurrentModel().code
  const item = useItem(model, id)
  const detail = item.data
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-280 gap-4 overflow-hidden">
        <DialogHeader>
          <DialogTitle>Кадры перед отправкой</DialogTitle>
          <DialogDescription>{detail ? sheetSubtitle(detail) : id}</DialogDescription>
        </DialogHeader>
        {detail ? (
          <SheetBody
            key={`${detail.entry.id}:${sheetVersionOf(detail)}`}
            detail={detail}
            onClose={onClose}
          />
        ) : item.isError ? (
          <ErrorLine message="Кадры не загрузились" onRetry={() => void item.refetch()} />
        ) : (
          <div aria-busy className={FRAME_GRID}>
            {Array.from({ length: SKELETON_FRAMES }, (_, index) => (
              <Skeleton key={index} className="aspect-9/16 rounded-lg" />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** «CUS-181 · Нейлон и каблуки · мастер v2 · имени нет». */
function sheetSubtitle(detail: ItemDetail): string {
  const { entry } = detail
  const master = detail.files.find((file) => file.role === 'master')
  return [
    entry.id,
    entry.title,
    master ? `мастер v${master.current_version}` : null,
    entry.fan_name ? FAN_NAME_LABEL[entry.fan_name] : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function SheetBody({ detail, onClose }: { detail: ItemDetail; onClose: () => void }) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const writeItem = useItemWriter(model)
  const role = useRole()
  const canAct = role === 'owner' || role === 'manager'
  const frames = sheetFramesOf(detail)
  const version = sheetVersionOf(detail)
  const check = sheetCheckOf(detail)
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(() => initialBlocked(detail))
  const wholeVideo = isWholeVideo(detail)
  const sendBlocked = wholeVideo && blocked.size > 0

  const save = useIntentMutation<SaveFrameCheckCommand, ItemDetail>({
    failed: 'Проверка не сохранилась',
    run: (body, idempotencyKey) =>
      api.objects.saveFrameCheck({
        params: { model, id: detail.entry.id },
        body,
        ifMatch: detail.version,
        idempotencyKey,
      }),
    invalidates: () => [markupReviewKey(model)],
    onSuccess: (saved, body) => {
      writeItem(saved)
      onClose()
      toast.show({
        message: `${saved.entry.id}: ${VERDICT_WORD[body.verdict].toLowerCase()} · проверено для v${body.version}`,
      })
    },
  })

  const toggle = (key: string) =>
    setBlocked((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  const submit = (verdict: FrameCheck['verdict']) =>
    save.start({ version, blocked: [...blocked], verdict })

  if (frames.length === 0) {
    return (
      <p className="text-muted-foreground">Кадров мастера ещё нет — они собираются при приёмке</p>
    )
  }
  return (
    <>
      {canAct ? (
        <p className="-mt-2 text-ink-3 text-sm">
          Нажмите на кадр, который нельзя отправлять; нажмите ещё раз, чтобы вернуть
        </p>
      ) : null}
      <ul className={cn(FRAME_GRID, 'min-h-0 overflow-y-auto p-1')}>
        {frames.map((frame) => (
          <FrameTile
            key={frame.key}
            frame={frame}
            blocked={blocked.has(frame.key)}
            canAct={canAct}
            onToggle={() => toggle(frame.key)}
          />
        ))}
      </ul>
      <DialogFooter className="justify-between border-border border-t pt-4">
        <CheckLine check={check} blocked={blocked.size} />
        {canAct ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => submit('hold')}
              aria-busy={save.isPending}
              disabled={save.isPending}
            >
              Не отправлять
            </Button>
            <Button
              onClick={() => submit('send')}
              aria-busy={save.isPending}
              disabled={save.isPending || sendBlocked}
              title={
                sendBlocked
                  ? 'Отмечены кадры «Не отправлять» — ролик целиком не отправить'
                  : undefined
              }
            >
              {!wholeVideo && blocked.size > 0
                ? `Можно отправлять · без ${framesWord(blocked.size)}`
                : 'Можно отправлять'}
            </Button>
          </div>
        ) : null}
      </DialogFooter>
    </>
  )
}

function FrameTile({
  frame,
  blocked,
  canAct,
  onToggle,
}: {
  frame: SheetFrame
  blocked: boolean
  canAct: boolean
  onToggle: () => void
}) {
  const picture = (
    <>
      <Thumb
        {...frame.cover}
        aspect={frame.aspect}
        showCaptions={false}
        className={cn('w-full rounded-lg transition-opacity duration-120', blocked && 'opacity-40')}
      />
      {blocked ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 whitespace-nowrap font-medium text-sm">
          <StatusSign kind="trouble" />
          не отправлять
        </span>
      ) : null}
    </>
  )
  const frameClass = cn(
    'relative block w-full overflow-hidden rounded-lg',
    blocked && 'ring-2 ring-destructive ring-offset-2 ring-offset-popover',
  )
  return (
    <li className="flex flex-col gap-1">
      {canAct ? (
        <button
          type="button"
          aria-pressed={blocked}
          aria-label={`${blocked ? 'Вернуть' : 'Не отправлять'} кадр ${frame.caption}`}
          title={blocked ? 'Вернуть кадр' : 'Не отправлять этот кадр'}
          onClick={onToggle}
          className={cn(
            frameClass,
            'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {picture}
        </button>
      ) : (
        <div className={frameClass}>{picture}</div>
      )}
      <span className="text-ink-3 text-sm tabular-nums">{frame.caption}</span>
    </li>
  )
}

/** Итог последней проверки: «✓ Можно отправлять · проверено для v2 · Диана, сегодня 14:10». */
function CheckLine({ check, blocked }: { check: SheetCheck; blocked: number }) {
  const now = useClock().now()
  if (check.kind === 'none') {
    return (
      <p className="text-ink-3 text-sm">
        {blocked > 0 ? `Отмечено: ${framesWord(blocked)}` : 'Кадры ещё не проверяли'}
      </p>
    )
  }
  const { verdict, version, by, at } = check.check
  if (check.kind === 'stale') {
    return (
      <p className="text-ink-3 text-sm">
        Проверяли v{version} — мастер с тех пор изменился, посмотрите заново
      </p>
    )
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-base">
      <StatusSign kind={verdict === 'send' ? 'done' : 'trouble'} />
      {VERDICT_WORD[verdict]}
      <span className="text-ink-3 text-sm">
        проверено для v{version} · {by}, {formatWhen(at, now)}
      </span>
    </p>
  )
}
