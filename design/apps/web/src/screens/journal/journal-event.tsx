import {
  formatClock,
  formatDate,
  type ItemId,
  JOURNAL_AREA_LABEL,
  type JournalEvent,
  type JournalResult,
  type LocalDate,
  type ModelCode,
  mskDate,
} from '@contentops/contracts'
import { EventDetails, EventRow } from '@contentops/ui/components/event-row'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { stopRowClick } from '@contentops/ui/components/stop-row-click'
import { Thumb } from '@contentops/ui/components/thumb'
import { Link } from '@tanstack/react-router'
import { Fragment } from 'react'
import { useToday } from '@/data/api-session'
import { itemCoverById } from '@/lib/item-cover'

interface JournalEventRowProps {
  event: JournalEvent
  model: ModelCode
  expanded: boolean
  selected: boolean
  onToggle: () => void
  menu: ItemMenuModel
}

/** Номер объекта во фразе — ссылкой: «Диана приняла [SET-073] из «4. Sets/19.09.26»». */
function TextWithItem({
  text,
  item,
  model,
}: {
  text: string
  item: ItemId | null
  model: ModelCode
}) {
  if (!item || !text.includes(item)) {
    return text
  }
  const parts = text.split(item)
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? (
        <Link
          to="/$model/i/$id"
          params={{ model, id: item }}
          onClick={stopRowClick}
          className="text-primary-ink tabular-nums underline-offset-4 hover:underline"
        >
          {item}
        </Link>
      ) : null}
    </Fragment>
  ))
}

/** Слово исхода, которое красится во фразе (§4.18): «отказ», «ошибка». */
const RESULT_WORD: Record<Exclude<JournalResult, 'ok'>, string> = {
  denied: 'отказ',
  error: 'ошибка',
}

/**
 * Фраза сервера: объект ссылкой, у отказа и ошибки красным только само слово —
 * «Агент импорта: [отказ] — нет прав на модель Ари». Если слова во фразе нет, оно встаёт
 * впереди, чтобы исход не держался на одном цвете.
 */
function Phrase({ event, model }: { event: JournalEvent; model: ModelCode }) {
  const item = event.item_id
  if (event.result === 'ok') {
    return <TextWithItem text={event.phrase} item={item} model={model} />
  }
  const word = RESULT_WORD[event.result]
  const at = event.phrase.toLowerCase().indexOf(word)
  if (at < 0) {
    return (
      <>
        <span className="text-destructive">{word.charAt(0).toUpperCase() + word.slice(1)}</span>
        {': '}
        <TextWithItem text={event.phrase} item={item} model={model} />
      </>
    )
  }
  return (
    <>
      <TextWithItem text={event.phrase.slice(0, at)} item={item} model={model} />
      <span className="text-destructive">{event.phrase.slice(at, at + word.length)}</span>
      <TextWithItem text={event.phrase.slice(at + word.length)} item={item} model={model} />
    </>
  )
}

/** Миниатюра предмета ведёт в объект, даже когда номера нет во фразе. */
function ItemThumb({ item, model }: { item: ItemId; model: ModelCode }) {
  return (
    <Link
      to="/$model/i/$id"
      params={{ model, id: item }}
      onClick={stopRowClick}
      aria-label={`Открыть ${item}`}
      title={item}
      className="block rounded-md"
    >
      <Thumb
        {...itemCoverById(item)}
        aspect="1:1"
        showCaptions={false}
        className="w-8 rounded-md"
      />
    </Link>
  )
}

/**
 * Событие журнала (DESIGN §4.18): время, автор значком, фраза с объектом ссылкой,
 * миниатюра предмета. Нажатие раскрывает «было → стало».
 */
export function JournalEventRow({
  event,
  model,
  expanded,
  selected,
  onToggle,
  menu,
}: JournalEventRowProps) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Enter раскрывает событие через список-владелец
    // biome-ignore lint/a11y/noStaticElementInteractions: строка — вариант списка с aria-activedescendant
    <div
      onClick={(click) => {
        // Второй щелчок двойного нажатия не сворачивает только что раскрытое.
        if (click.detail <= 1) {
          onToggle()
        }
      }}
    >
      <EventRow
        time={formatClock(event.at)}
        actor={event.actor.type}
        expanded={expanded}
        selected={selected}
        thumb={event.item_id ? <ItemThumb item={event.item_id} model={model} /> : null}
        menu={
          // biome-ignore lint/a11y/noStaticElementInteractions: обёртка только гасит всплытие щелчка
          // biome-ignore lint/a11y/useKeyWithClickEvents: у кнопки меню свои клавиши
          <span onClick={stopRowClick}>
            <ItemMenuButton menu={menu} label="Действия события" size="icon-sm" />
          </span>
        }
      >
        <Phrase event={event} model={model} />
      </EventRow>
    </div>
  )
}

/** «22.09, 13:52 · Агент приёмки · Приёмка»; в другом году — «22.09.2025, 13:52 · …». */
function metaOf(event: JournalEvent, today: LocalDate): string {
  const when = `${formatDate(mskDate(event.at), today)}, ${formatClock(event.at)}`
  const area = JOURNAL_AREA_LABEL[event.area]
  return [when, event.actor.name, ...(area === event.actor.name ? [] : [area])].join(' · ')
}

export function JournalEventDetails({ event }: { event: JournalEvent }) {
  const today = useToday()
  return <EventDetails changes={event.changes} meta={metaOf(event, today)} />
}
