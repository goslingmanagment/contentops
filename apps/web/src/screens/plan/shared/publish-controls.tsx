import {
  formatNumber,
  type PlanRow,
  PUBLICATION_KIND_LABEL,
  type PublicationCheck,
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
import { StatusSign } from '@contentops/ui/components/status-sign'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { cn } from '@contentops/ui/lib/utils'
import { SendIcon, UploadCloudIcon } from 'lucide-react'
import { useState } from 'react'
import { accountLabel } from '@/lib/words'
import { useCurrentModel } from '@/shell/model/model-context'
import { usePublishActions } from './actions/use-publish-actions'
import { slotText } from './plan-text'

/**
 * Кнопки публикации через Hub (DESIGN §4.11): «Подготовить» — Hub получает недостающие файлы
 * и делает черновик; «Отправить» — окно с проверками Hub, человек подтверждает; пока работа
 * идёт — неактивная кнопка «Hub готовит…».
 */

interface ButtonLook {
  variant: 'row' | 'panel'
}

const look = ({ variant }: ButtonLook) => ({
  variant: variant === 'panel' ? ('default' as const) : ('outline' as const),
  size: variant === 'panel' ? ('default' as const) : ('sm' as const),
  className: variant === 'panel' ? 'w-full' : undefined,
})

export function PrepareButton({
  row,
  again,
  variant,
}: ButtonLook & { row: PlanRow; again: boolean }) {
  const publish = usePublishActions()
  return (
    <Button {...look({ variant })} pending={publish.preparing} onClick={() => publish.prepare(row)}>
      {variant === 'panel' ? <UploadCloudIcon /> : null}
      {again ? 'Подготовить заново' : 'Подготовить'}
    </Button>
  )
}

const PENDING_WORD = {
  prepare: 'Hub готовит…',
  send: 'Отправляется…',
  cancel: 'Отменяется…',
} as const

export function PendingButton({ op, variant }: ButtonLook & { op: keyof typeof PENDING_WORD }) {
  return (
    <Button {...look({ variant })} disabled pending>
      {PENDING_WORD[op]}
    </Button>
  )
}

export function SendButton({
  row,
  blocked,
  variant,
}: ButtonLook & { row: PlanRow; blocked: string | null }) {
  const [open, setOpen] = useState(false)
  const button = (
    <Button {...look({ variant })} disabled={blocked !== null} onClick={() => setOpen(true)}>
      {variant === 'panel' ? <SendIcon /> : null}
      Отправить
    </Button>
  )
  return (
    <>
      {blocked && variant === 'row' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{button}</span>
          </TooltipTrigger>
          <TooltipContent>{blocked}</TooltipContent>
        </Tooltip>
      ) : blocked ? (
        // В панели причина — словами под неактивной кнопкой (DESIGN §4.11).
        <div className="flex w-full flex-col gap-1.5">
          {button}
          <p className="text-destructive text-sm">{blocked}</p>
        </div>
      ) : (
        button
      )}
      {open ? <SendDialog row={row} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const CHECK_SIGN: Record<PublicationCheck['severity'], 'trouble' | 'turn' | null> = {
  blocking: 'trouble',
  warning: 'turn',
  info: null,
}

/** Проверки Hub строкой: блокирующие — ▲, предупреждения — янтарём, сведения — серым. */
export function CheckLines({ checks }: { checks: readonly PublicationCheck[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {checks.map((check) => (
        <li
          key={check.code}
          className={cn(
            'flex items-start gap-1.5 text-sm',
            check.severity === 'blocking'
              ? 'text-destructive'
              : check.severity === 'warning'
                ? 'text-attention-ink'
                : 'text-ink-3',
          )}
        >
          {CHECK_SIGN[check.severity] ? (
            <StatusSign kind={CHECK_SIGN[check.severity] ?? 'turn'} size={14} className="mt-0.5" />
          ) : null}
          <span>{check.text}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * «Отправить» (DESIGN §4.11, SPEC §7): КМ видит проверки Hub и подтверждает; ContentOps
 * утверждает публикацию той версии черновика, которую человек видел.
 */
function SendDialog({ row, onClose }: { row: PlanRow; onClose: () => void }) {
  const model = useCurrentModel()
  const publish = usePublishActions()
  const publication = row.hub?.publication
  if (!publication) {
    return null
  }
  const warnings = publication.checks.filter((check) => check.severity !== 'blocking')
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-120">
        <DialogHeader>
          <DialogTitle>Отправить в Hub</DialogTitle>
          <DialogDescription>
            {row.manifest?.item_id} · {accountLabel(model.accounts, row.account)} ·{' '}
            {PUBLICATION_KIND_LABEL[publication.kind]} · {slotText(row.date, row.time)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-base">
          <ul className="flex flex-col gap-1 text-sm">
            {publication.files.map((file) => (
              <li key={file.name} className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-mono text-xs">{file.name}</span>
                <span className="shrink-0 text-ink-3">
                  {file.source === 'vault' ? 'уже в vault' : 'в Hub'}
                </span>
              </li>
            ))}
          </ul>
          {warnings.length > 0 ? (
            <CheckLines checks={warnings} />
          ) : (
            <p className="text-ink-3 text-sm">Проверки Hub прошли.</p>
          )}
          <p className="text-ink-3 text-sm">
            Hub опубликует в {row.time ?? 'срок строки'}. Отменить можно, пока Hub не поставил
            публикацию в расписание площадки — за 7 дней до выхода; позже — только владелец в Hub.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            pending={publish.sending}
            onClick={() => {
              publish.send(row, publication.version)
              onClose()
            }}
          >
            <SendIcon />
            Отправить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * «Отправить 12» (DESIGN §4.11): одно окно со сводкой проверок Hub — что уйдёт (с
 * предупреждениями янтарём) и что останется из-за блокирующей проверки.
 */
export function SendManyDialog({
  send,
  blocked,
  pending,
  onSend,
  onClose,
}: {
  send: readonly PlanRow[]
  blocked: readonly PlanRow[]
  pending: boolean
  onSend: () => void
  onClose: () => void
}) {
  const model = useCurrentModel()
  const label = (row: PlanRow) =>
    `${row.manifest?.item_id ?? 'строка'} · ${accountLabel(model.accounts, row.account)} · ${slotText(row.date, row.time)}`
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-140">
        <DialogHeader>
          <DialogTitle>Отправить в Hub · {formatNumber(send.length)}</DialogTitle>
          <DialogDescription>
            ContentOps утвердит черновики, которые вы видите; отменить можно, пока Hub не поставил
            публикацию в расписание площадки — за 7 дней до выхода.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-base">
          <ul className="flex flex-col gap-2">
            {send.map((row) => {
              const warnings = (row.hub?.publication?.checks ?? []).filter(
                (check) => check.severity !== 'blocking',
              )
              return (
                <li key={row.id} className="flex flex-col gap-1">
                  <span>
                    {label(row)} ·{' '}
                    <span className="text-ink-3">
                      {row.hub?.publication ? PUBLICATION_KIND_LABEL[row.hub.publication.kind] : ''}
                    </span>
                  </span>
                  {warnings.length > 0 ? <CheckLines checks={warnings} /> : null}
                </li>
              )
            })}
          </ul>
          {blocked.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t pt-3">
              <p className="text-ink-3 text-sm">
                Останутся — блокирующая проверка Hub: {formatNumber(blocked.length)}
              </p>
              <ul className="flex flex-col gap-2">
                {blocked.map((row) => (
                  <li key={row.id} className="flex flex-col gap-1">
                    <span>{label(row)}</span>
                    <CheckLines
                      checks={(row.hub?.publication?.checks ?? []).filter(
                        (check) => check.severity === 'blocking',
                      )}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={send.length === 0}
            pending={pending}
            onClick={() => {
              onSend()
              onClose()
            }}
          >
            <SendIcon />
            Отправить {formatNumber(send.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
