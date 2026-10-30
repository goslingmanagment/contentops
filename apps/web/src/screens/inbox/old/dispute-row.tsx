import type { Dispute, DisputeOption } from '@contentops/contracts'
import { capitalize } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronDownIcon } from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import type { DisputeAnswer } from '@/data/inbox'
import { DisputeAnswerForm } from './dispute-answer'
import { choiceByDigit, type DisputeChoices, disputeChoices } from './dispute-choices'
import { type FolderChoice, FolderChoices, proposedChoice, sameChoice } from './folder-choices'
import { BY_LABELS_OPTION, FOLDERS_OPTION } from './use-legacy-actions'

const DIGITS: Readonly<Record<string, number>> = { Digit1: 1, Digit2: 2, Digit3: 3 }

interface DisputeRowProps {
  dispute: Dispute
  open: boolean
  pending: boolean
  onToggle: () => void
  /** Решение; `row` — строка, от которой фокус пойдёт к следующему нерешённому случаю. */
  onChoose: (
    option: DisputeOption,
    folders: FolderChoice | undefined,
    row: HTMLElement,
    extra?: DisputeAnswer,
  ) => void
}

/**
 * Спорный случай строкой (DESIGN §4.9): обложки, название, фрагмент старого имени
 * моноширинным, главное решение сразу в строке. Раскрытая строка показывает предложение
 * и остальные варианты. `1` `2` `3` — решения по порядку, `Enter` — раскрыть.
 *
 * «Номер занят» перенумеровывает папки, а это не отменить: второй строкой видна суть
 * предложения, в раскрытой строке — папки с выбором у каждой, и `1` на свёрнутой строке
 * только раскрывает её.
 */
export function DisputeRow({ dispute, open, pending, onToggle, onChoose }: DisputeRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const choices = disputeChoices(dispute)
  const byFolder = dispute.kind === 'number_taken' && dispute.folders.length > 0
  const proposed = proposedChoice(dispute.folders)
  const [folderChoice, setFolderChoice] = useState<FolderChoice>(proposed)
  const changed = byFolder && !sameChoice(folderChoice, proposed)
  // Вариант со словами («Игнорировать…», «Задать тип и номер…»): сначала форма в строке.
  const [asking, setAsking] = useState<DisputeOption | null>(null)

  const choose = (option: DisputeOption, folders?: FolderChoice, extra?: DisputeAnswer) => {
    if (option.input && !extra) {
      setAsking(option)
      if (!open) {
        onToggle()
      }
      return
    }
    setAsking(null)
    if (rowRef.current) {
      onChoose(option, folders, rowRef.current, extra)
    }
  }
  // Главное решение раскрытой «Номер занят»: предложение как есть или выбор у папок.
  const applyFolders = () => {
    if (changed) {
      choose({ key: FOLDERS_OPTION, label: 'Сохранить выбор' }, folderChoice)
    } else if (choices.primary) {
      choose(choices.primary)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return
    }
    const digit = DIGITS[event.code]
    if (digit && byFolder && !dispute.resolved) {
      event.preventDefault()
      if (!open) {
        onToggle()
      } else if (digit === 1) {
        applyFolders()
      }
      return
    }
    const option = digit ? choiceByDigit(choices, digit) : null
    if (option) {
      event.preventDefault()
      choose(option)
    } else if (event.code === 'Enter') {
      event.preventDefault()
      onToggle()
    }
  }
  const settled = dispute.resolved !== null || dispute.postponed !== null
  const secondLine = byFolder ? dispute.proposal : dispute.fragment
  return (
    // biome-ignore lint/a11y/useSemanticElements: строка с кнопками внутри не может быть <button>
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      data-dispute-row=""
      data-settled={settled}
      onKeyDown={onKeyDown}
      onClick={onToggle}
      className={cn(
        'flex flex-col rounded-lg px-2 outline-none transition-colors duration-120 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        dispute.resolved && 'text-muted-foreground',
      )}
    >
      <div className="flex min-h-16 min-w-0 items-center gap-3">
        <span className="flex w-24 shrink-0 gap-1">
          {dispute.thumbs.slice(0, 3).map((thumb) => (
            <Thumb
              key={thumb.key}
              seed={thumb.key}
              showCaptions={false}
              className="w-7.5 rounded-md"
            />
          ))}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{dispute.title}</span>
          {secondLine ? (
            <span className={cn('truncate text-ink-3', byFolder ? 'text-sm' : 'font-mono text-xs')}>
              {secondLine}
            </span>
          ) : null}
        </span>
        {byFolder && open && !dispute.resolved ? null : (
          <RowAction
            dispute={dispute}
            primary={choices.primary}
            pending={pending}
            onChoose={(option) => choose(option)}
          />
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-ink-3 transition-transform duration-120',
            open && 'rotate-180',
          )}
        />
      </div>
      {open && byFolder && !dispute.resolved ? (
        <div className="flex flex-col gap-3 pb-3 pl-27">
          <FolderChoices
            dispute={dispute}
            value={folderChoice}
            disabled={pending}
            onChange={(folder, option) =>
              setFolderChoice((current) => ({ ...current, [folder]: option }))
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={(event) => {
                event.stopPropagation()
                applyFolders()
              }}
            >
              {changed ? 'Сохранить выбор' : (choices.primary?.label ?? 'Так и сделать')}
            </Button>
            <UnclearButton choices={choices} pending={pending} onChoose={choose} />
          </div>
        </div>
      ) : null}
      {open && !byFolder && !settled ? (
        <div className="flex flex-col gap-2 pb-3 pl-27">
          {dispute.proposal && dispute.kind !== 'label_from_name' ? (
            <p className="text-sm">{dispute.proposal}</p>
          ) : null}
          {asking ? (
            <DisputeAnswerForm
              option={asking}
              pending={pending}
              onSubmit={(answer) => choose(asking, undefined, answer)}
              onCancel={() => setAsking(null)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {choices.others.map((option) => (
              <Button
                key={option.key}
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={(event) => {
                  event.stopPropagation()
                  choose(option)
                }}
              >
                {capitalize(option.label)}
              </Button>
            ))}
            <UnclearButton choices={choices} pending={pending} onChoose={choose} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function UnclearButton({
  choices,
  pending,
  onChoose,
}: {
  choices: DisputeChoices
  pending: boolean
  onChoose: (option: DisputeOption) => void
}) {
  const unclear = choices.unclear
  if (!unclear) {
    return null
  }
  return (
    <Button
      variant="link"
      size="sm"
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation()
        onChoose(unclear)
      }}
    >
      {unclear.label}
    </Button>
  )
}

function RowAction({
  dispute,
  primary,
  pending,
  onChoose,
}: {
  dispute: Dispute
  primary: DisputeOption | null
  pending: boolean
  onChoose: (option: DisputeOption) => void
}) {
  if (dispute.resolved) {
    return (
      <StatusWord sign="done" className="shrink-0">
        {dispute.resolved.option === BY_LABELS_OPTION ? 'по карточке меток' : 'разобрано'} ·{' '}
        {dispute.resolved.by}
      </StatusWord>
    )
  }
  if (dispute.postponed) {
    return <span className="shrink-0 text-muted-foreground text-sm">{dispute.postponed}</span>
  }
  if (!primary) {
    return null
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation()
        onChoose(primary)
      }}
      className="shrink-0"
    >
      {capitalize(primary.label)}
    </Button>
  )
}
