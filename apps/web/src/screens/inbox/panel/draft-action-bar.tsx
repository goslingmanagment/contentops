import type { InboxGroup } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useUploads } from '@/shell/upload/upload-context'
import type { IntakeActions } from '../shared/use-intake-actions'
import { draftActionsOf, type PrimaryKind, type SecondaryKind } from './draft-actions'
import { ExtendPopover } from './extend-popover'
import { RejectPopover } from './reject-popover'

/**
 * Откуда открыли всплывашку: клавишей из списка — туда и вернётся фокус после неё, чтобы
 * цифры, стрелки и `Space` снова работали (§3.12); иначе — на кнопку, как обычно (§7.8).
 */
export type PopoverOrigin = 'list' | 'panel'

/** Что панель умеет по команде извне: клавиши `1` `2` `3`, `Enter` и меню группы. */
export interface ActionBarHandle {
  primary: () => void
  /** Второй вариант: «Дополнить…» или «Оставить в каталоге». */
  second: (origin?: PopoverOrigin) => void
  extend: (origin?: PopoverOrigin) => void
  reject: (origin?: PopoverOrigin) => void
  focus: () => void
}

interface DraftActionBarProps {
  group: InboxGroup
  actions: IntakeActions
  /** «Ждать» у пропавшей с Я.Диска: группа остаётся, фокус идёт дальше. */
  onSkip: () => void
  /** Вернуть фокус в список групп — после всплывашки, открытой клавишей оттуда. */
  onReturnToList: () => void
  /** Вторая дорога выбрана: дополнение или исправление принимается новым объектом. */
  separate: boolean
  onSeparateChange: (separate: boolean) => void
  handleRef: Ref<ActionBarHandle>
}

type OpenPopover = 'extend' | 'reject' | null

/**
 * Кнопки сверху панели, всегда в видимой зоне (DESIGN §4.8): главная синяя, под ней
 * «Дополнить…» и «Отклонить…», ниже одна строка — причина или вторая дорога.
 */
export function DraftActionBar({
  group,
  actions,
  onSkip,
  onReturnToList,
  separate,
  onSeparateChange,
  handleRef,
}: DraftActionBarProps) {
  const model = draftActionsOf(group, separate)
  const { openUploadDialog } = useUploads()
  const [popover, setPopover] = useState<OpenPopover>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const origin = useRef<PopoverOrigin>('panel')

  useEffect(() => {
    setPopover(null)
  }, [group.id])

  const openPopover = (kind: Exclude<OpenPopover, null>, from: PopoverOrigin) => {
    origin.current = from
    setPopover(kind)
  }
  // Всплывашка, открытая из списка, отдаёт фокус списку, а не своей кнопке.
  const onCloseAutoFocus = (event: Event) => {
    if (origin.current === 'list') {
      event.preventDefault()
      onReturnToList()
    }
    origin.current = 'panel'
  }

  const runPrimary: Record<PrimaryKind, () => void> = {
    accept: () => actions.accept(group, model.primary.command),
    retry: () => actions.retry(group.id),
    wait: onSkip,
    reupload: () => openUploadDialog(),
    substitute: () => actions.decide(group, { decision: 'substitute_montage', substitute: true }),
  }
  const runSecondary: Record<SecondaryKind, (from: PopoverOrigin) => void> = {
    extend: (from) => openPopover('extend', from),
    reject: (from) => openPopover('reject', from),
    keep_in_catalog: () =>
      actions.decide(group, { decision: 'substitute_montage', substitute: false }),
  }
  const primary = () => {
    if (model.primary.enabled) {
      runPrimary[model.primary.kind]()
    }
  }
  const [second] = model.secondary

  useImperativeHandle(handleRef, () => ({
    primary,
    second: (from = 'panel') => {
      if (second && second !== 'reject') {
        runSecondary[second](from)
      }
    },
    extend: (from = 'panel') => {
      if (model.secondary.includes('extend')) {
        openPopover('extend', from)
      }
    },
    reject: (from = 'panel') => {
      if (model.secondary.includes('reject')) {
        openPopover('reject', from)
      }
    },
    focus: () => primaryRef.current?.focus(),
  }))

  const pending =
    (model.primary.kind === 'accept' && actions.accepting) ||
    (model.primary.kind === 'retry' && actions.retrying) ||
    (model.primary.kind === 'substitute' && actions.deciding)

  return (
    <div className="flex flex-col gap-2">
      <Button
        ref={primaryRef}
        disabled={!model.primary.enabled}
        pending={pending}
        onClick={primary}
        className="w-full"
      >
        {model.primary.label}
      </Button>
      <div className="flex gap-2">
        {model.secondary.map((kind) => (
          <SecondaryButton
            key={kind}
            kind={kind}
            group={group}
            open={popover === kind}
            onOpenChange={(open) => {
              if (open && kind !== 'keep_in_catalog') {
                openPopover(kind, 'panel')
              } else {
                setPopover(null)
              }
            }}
            onSelect={() => runSecondary[kind]('panel')}
            onCloseAutoFocus={onCloseAutoFocus}
            actions={actions}
          />
        ))}
      </div>
      <div className="flex min-h-4.5 items-center text-sm">
        {model.note?.kind === 'reason' ? (
          <span className="text-muted-foreground">{model.note.text}</span>
        ) : null}
        {model.note?.kind === 'switch' ? (
          <AlternativeLink
            label={model.note.label}
            onSelect={() => {
              if (model.note?.kind === 'switch') {
                onSeparateChange(model.note.separate)
              }
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function AlternativeLink({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <Button variant="link" size="inline" onClick={onSelect} className="text-sm">
      {label}
    </Button>
  )
}

const SECONDARY_LABEL: Record<SecondaryKind, string> = {
  extend: 'Дополнить…',
  reject: 'Отклонить…',
  keep_in_catalog: 'Оставить в каталоге',
}

function SecondaryButton({
  kind,
  group,
  open,
  onOpenChange,
  onSelect,
  onCloseAutoFocus,
  actions,
}: {
  kind: SecondaryKind
  group: InboxGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: () => void
  onCloseAutoFocus: (event: Event) => void
  actions: IntakeActions
}) {
  const button = (
    <Button
      variant="outline"
      className="min-w-0 flex-1"
      onClick={kind === 'keep_in_catalog' ? onSelect : undefined}
    >
      {SECONDARY_LABEL[kind]}
    </Button>
  )
  if (kind === 'extend') {
    return (
      <ExtendPopover
        group={group}
        open={open}
        onOpenChange={onOpenChange}
        onCloseAutoFocus={onCloseAutoFocus}
        onExtend={(itemId, role) =>
          actions.accept(group, { as: 'default', extend: { item_id: itemId, role } })
        }
      >
        {button}
      </ExtendPopover>
    )
  }
  if (kind === 'reject') {
    return (
      <RejectPopover
        open={open}
        onOpenChange={onOpenChange}
        onCloseAutoFocus={onCloseAutoFocus}
        onReject={(reason) => actions.reject([group.id], reason)}
        align="end"
      >
        {button}
      </RejectPopover>
    )
  }
  return button
}
