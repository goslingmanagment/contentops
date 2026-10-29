import {
  type PersonRef,
  UNIQ_LEVEL_LABEL,
  type UniqLevel,
  UniqLevelSchema,
  type UpdateWeekNormCommand,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import type { ReactNode } from 'react'
import { everyWeeksText, WEEKDAY_SHORT } from './norm-text'

type Release = UpdateWeekNormCommand['release']

const EVERY_WEEKS = [1, 2, 3, 4] as const
const DEFAULT_RELEASE: NonNullable<Release> = { every_weeks: 2, weekday: 3, time: '20:00' }

interface LineProps {
  label: string
  children: ReactNode
}

/** Строка «Подпись: значение» под сеткой. */
function Line({ label, children }: LineProps) {
  return (
    <div className="flex min-h-9 items-center gap-3">
      <span className="w-44 shrink-0 text-muted-foreground text-sm">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  )
}

interface ReleaseLineProps {
  release: Release
  readOnly: boolean
  onChange: (release: Release) => void
}

/**
 * Выпуск PPV отдельной строкой (DESIGN §4.14): «раз в 2 недели · чт ▾ · 20:00». Выпуск
 * считается один раз, не по ячейкам.
 */
export function ReleaseLine({ release, readOnly, onChange }: ReleaseLineProps) {
  if (!release) {
    return (
      <Line label="Выпуск PPV">
        <span className="text-ink-3 text-sm">нет</span>
        {readOnly ? null : (
          <Button variant="link" size="inline" onClick={() => onChange(DEFAULT_RELEASE)}>
            Добавить
          </Button>
        )}
      </Line>
    )
  }
  if (readOnly) {
    return (
      <Line label="Выпуск PPV">
        <span className="text-base">
          {everyWeeksText(release.every_weeks)} · {WEEKDAY_SHORT[release.weekday]} · {release.time}
        </span>
      </Line>
    )
  }
  return (
    <Line label="Выпуск PPV">
      <Select
        value={String(release.every_weeks)}
        onValueChange={(next) => onChange({ ...release, every_weeks: Number(next) })}
      >
        <SelectTrigger size="sm" aria-label="Как часто">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EVERY_WEEKS.map((weeks) => (
            <SelectItem key={weeks} value={String(weeks)}>
              {everyWeeksText(weeks)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={String(release.weekday)}
        onValueChange={(next) => onChange({ ...release, weekday: Number(next) })}
      >
        <SelectTrigger size="sm" aria-label="День выпуска">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WEEKDAY_SHORT.map((day, index) => (
            <SelectItem key={day} value={String(index)}>
              {day}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="time"
        value={release.time}
        onChange={(event) => onChange({ ...release, time: event.target.value || release.time })}
        aria-label="Время выпуска"
        className="h-7.5 w-20 px-2 text-sm tabular-nums [&::-webkit-calendar-picker-indicator]:hidden"
      />
      <Button variant="link" size="inline" className="text-sm" onClick={() => onChange(null)}>
        Убрать
      </Button>
    </Line>
  )
}

interface PostingLinesProps {
  assignee: string | null
  level: UniqLevel
  /** Фупов на OnlyFans нет — и уровня версий у страницы OnlyFans нет. */
  withFypLevel: boolean
  people: readonly PersonRef[]
  readOnly: boolean
  onAssigneeChange: (assignee: string | null) => void
  onLevelChange: (level: UniqLevel) => void
}

const NOBODY = 'nobody'

/** «Обычно выкладывает: Диана ▾», у страниц Fansly — «Уровень версий фупа: мягко ▾». */
export function PostingLines({
  assignee,
  level,
  withFypLevel,
  people,
  readOnly,
  onAssigneeChange,
  onLevelChange,
}: PostingLinesProps) {
  const person = people.find((candidate) => candidate.id === assignee)
  return (
    <>
      <Line label="Обычно выкладывает">
        {readOnly ? (
          <span className="text-base">{person?.name ?? 'никто'}</span>
        ) : (
          <Select
            value={assignee ?? NOBODY}
            onValueChange={(next) => onAssigneeChange(next === NOBODY ? null : next)}
          >
            <SelectTrigger size="sm" aria-label="Обычно выкладывает">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {people.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
              <SelectItem value={NOBODY}>никто</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Line>
      {withFypLevel ? (
        <Line label="Уровень версий фупа">
          {readOnly ? (
            <span className="text-base">{UNIQ_LEVEL_LABEL[level]}</span>
          ) : (
            <Select
              value={level}
              onValueChange={(next) => {
                const parsed = UniqLevelSchema.safeParse(next)
                if (parsed.success) {
                  onLevelChange(parsed.data)
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Уровень версий фупа">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UniqLevelSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {UNIQ_LEVEL_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Line>
      ) : null}
    </>
  )
}
