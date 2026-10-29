import { formatDuration, type TimelineSegment } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { TimelineTrack } from '@contentops/ui/components/timeline-track'
import { PlusIcon, XIcon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { useObjectPage } from '../../object-context'
import { FieldRow } from './field-row'
import { useFieldSave } from './use-field-save'
import { useMarkupField } from './use-markup-field'

/** «4:10» → 250 секунд, «250» → 250; неверное — `null`. */
export function parseTimecode(text: string): number | null {
  const match = /^(\d+)(?::([0-5]\d))?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const whole = Number(match[1])
  return match[2] === undefined ? whole : whole * 60 + Number(match[2])
}

/**
 * «Хронология» (DESIGN §4.4, §4.20): дорожка отрезков и список «0:00 торт и свечи ·
 * 2:25 бельё». До ИИ минуты вносит КМ через «+ отрезок»; нажатие на отрезок открывает
 * просмотр мастера с этой секунды.
 */
export function TimelineField() {
  const { detail, canAct, openFile } = useObjectPage()
  const field = useMarkupField('timeline')
  const save = useFieldSave('timeline')
  const segments = field?.field.key === 'timeline' ? field.field.value : []
  const duration = detail.entry.duration_s ?? 0
  const sorted = [...segments].sort((left, right) => left.start_s - right.start_s)
  const [adding, setAdding] = useState(false)

  const write = (next: TimelineSegment[]) => save.save({ key: 'timeline', value: next })

  return (
    <FieldRow
      label="Хронология"
      field={field}
      conflict={save.conflict}
      onShowTheirs={save.showTheirs}
      onKeepMine={() => void save.keepMine()}
    >
      {() => (
        <div className="flex flex-col gap-2">
          {sorted.length > 0 && duration > 0 ? (
            <TimelineTrack
              durationSeconds={duration}
              segments={sorted.map((segment) => ({ start: segment.start_s, label: segment.label }))}
              onSeek={(seconds) => openFile('master', { seconds })}
            />
          ) : null}
          {sorted.length > 0 ? (
            <ul className="flex flex-col">
              {sorted.map((segment) => (
                <li
                  key={`${segment.start_s}-${segment.label}`}
                  className="group/segment flex h-8 items-center gap-2"
                >
                  <button
                    type="button"
                    onClick={() => openFile('master', { seconds: segment.start_s })}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:text-primary-ink"
                  >
                    <span className="w-10 shrink-0 text-ink-3 tabular-nums">
                      {formatDuration(segment.start_s)}
                    </span>
                    <span className="truncate">{segment.label}</span>
                  </button>
                  {canAct ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Убрать отрезок «${segment.label}»`}
                      onClick={() => write(sorted.filter((candidate) => candidate !== segment))}
                      className="opacity-0 group-hover/segment:opacity-100 focus-visible:opacity-100"
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {canAct && duration > 0 ? (
            adding ? (
              <SegmentForm
                duration={duration}
                onCancel={() => setAdding(false)}
                onAdd={(segment) => {
                  setAdding(false)
                  write([...sorted, segment])
                }}
              />
            ) : (
              <Button
                variant="link"
                size="inline"
                className="self-start text-sm"
                onClick={() => setAdding(true)}
              >
                <PlusIcon className="size-3.5" />
                отрезок
              </Button>
            )
          ) : null}
          {!canAct && sorted.length === 0 ? <p className="text-ink-3">не заполнено</p> : null}
        </div>
      )}
    </FieldRow>
  )
}

function SegmentForm({
  duration,
  onAdd,
  onCancel,
}: {
  duration: number
  onAdd: (segment: TimelineSegment) => void
  onCancel: () => void
}) {
  const [time, setTime] = useState('')
  const [label, setLabel] = useState('')
  const timeId = useId()
  const start = parseTimecode(time)
  const valid = start !== null && start <= duration && label.trim() !== ''
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && start !== null) {
      onAdd({ start_s: start, label: label.trim() })
    }
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      <label htmlFor={timeId} className="sr-only">
        Минута
      </label>
      <Input
        id={timeId}
        autoFocus
        inputMode="numeric"
        placeholder="4:10"
        value={time}
        onChange={(event) => setTime(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        className="h-8 w-16 tabular-nums"
      />
      <Input
        aria-label="Что в отрезке"
        placeholder="что происходит"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        className="h-8 min-w-0 flex-1"
      />
      <Button type="submit" size="sm" variant="outline" disabled={!valid}>
        Добавить
      </Button>
    </form>
  )
}
