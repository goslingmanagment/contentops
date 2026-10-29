import type { LocalDate, PersonRef, PlanRow } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Input } from '@contentops/ui/components/input'
import { Label } from '@contentops/ui/components/label'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { Textarea } from '@contentops/ui/components/textarea'
import { type ReactNode, useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { useCurrentModel } from '@/shell/model/model-context'
import { useRowActions } from '../actions/use-row-actions'
import { DayPicker } from '../day-picker'
import { rowsWord } from '../plan-text'
import type { RowEditMode } from '../row-menu'

interface RowEditProps {
  /** Одна строка из «⋯» строки или все выбранные из «⋯» полосы. */
  rows: readonly PlanRow[]
  mode: RowEditMode
  today: LocalDate
  /** Кто может выкладывать: люди, которые ведут страницы модели. */
  people: readonly PersonRef[]
  onDone: () => void
}

/**
 * Правка строки прямо в панели (DESIGN §3.9: окно только там, где много полей):
 * «Перенести…», «Заметка», «Передать другому».
 */
export function RowEdit({ rows, mode, today, people, onDone }: RowEditProps) {
  const first = rows[0]
  if (!first) {
    return null
  }
  switch (mode) {
    case 'move':
      return <MoveForm rows={rows} today={today} onDone={onDone} />
    case 'note':
      return <NoteForm row={first} onDone={onDone} />
    case 'assignee':
      return <AssigneeForm rows={rows} people={people} onDone={onDone} />
  }
}

function FormButtons({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <Button type="button" variant="ghost" onClick={onCancel}>
        Отмена
      </Button>
    </div>
  )
}

function editTitle(base: string, rows: readonly PlanRow[]): string {
  return rows.length > 1 ? `${base} · ${rowsWord(rows.length)}` : base
}

/** Перенос: день и, для одной строки, время. Страница остаётся прежней. */
function MoveForm({
  rows,
  today,
  onDone,
}: {
  rows: readonly PlanRow[]
  today: LocalDate
  onDone: () => void
}) {
  const actions = useRowActions()
  const timeId = useId()
  const first = rows[0]
  const single = rows.length === 1 ? first : undefined
  const [date, setDate] = useState<LocalDate>(() =>
    first && first.date >= today ? first.date : today,
  )
  const [time, setTime] = useState(single?.time ?? '')
  const changed =
    rows.some((row) => row.date !== date) || (single && (time || null) !== single.time)
  return (
    <InfoSection title={editTitle('Перенести', rows)}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          actions.moveMany(
            rows.map((row) => ({
              row,
              target: {
                date,
                time: single ? time || null : row.time,
                account: row.account,
              },
            })),
          )
          onDone()
        }}
      >
        <DayPicker value={date} onChange={setDate} today={today} label="День" />
        {single ? (
          <div className="flex items-center gap-3">
            <Label htmlFor={timeId} className="w-12 text-ink-3 text-sm">
              Время
            </Label>
            <Input
              id={timeId}
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="w-28"
            />
          </div>
        ) : null}
        <FormButtons onCancel={onDone}>
          <Button type="submit" disabled={!changed}>
            Перенести
          </Button>
        </FormButtons>
      </form>
    </InfoSection>
  )
}

/** Заметка сохраняется с версией записи: чужая правка не затирается молча (§3.10). */
function NoteForm({ row, onDone }: { row: PlanRow; onDone: () => void }) {
  const model = useCurrentModel().code
  const commands = usePlanCommands(model)
  const toast = useActionToast()
  const [note, setNote] = useState(row.note ?? '')
  const save = useVersionedSave({
    run: (change: { note: string | null }, version: number, key: string) =>
      commands.update({ key, row: row.id, version, change }),
    failed: 'Не сохранилось',
    subject: 'заметку',
    invalidates: planChangedKeys(model),
    onSuccess: () => {
      toast.show({ message: 'Сохранено' })
      onDone()
    },
  })
  const change = () => ({ note: note.trim() || null })
  return (
    <InfoSection title="Заметка">
      <form
        className="flex flex-col gap-3"
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
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Что важно для этой строки"
          aria-label="Заметка"
        />
        <FormButtons onCancel={onDone}>
          <Button type="submit" pending={save.isPending} disabled={note === (row.note ?? '')}>
            Сохранить
          </Button>
        </FormButtons>
      </form>
    </InfoSection>
  )
}

function AssigneeForm({
  rows,
  people,
  onDone,
}: {
  rows: readonly PlanRow[]
  people: readonly PersonRef[]
  onDone: () => void
}) {
  const actions = useRowActions()
  const current = rows.length === 1 ? (rows[0]?.assignee?.id ?? '') : ''
  const [chosen, setChosen] = useState(current)
  const person = people.find((candidate) => candidate.id === chosen)
  return (
    <InfoSection title={editTitle('Кто выкладывает', rows)}>
      <ChoiceChips
        label="Кто выкладывает"
        value={chosen || null}
        onChange={setChosen}
        choices={people.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
      />
      <FormButtons onCancel={onDone}>
        <Button
          disabled={!person || person.id === current}
          onClick={() => {
            if (person) {
              actions.assign(rows, person)
              onDone()
            }
          }}
        >
          Передать
        </Button>
      </FormButtons>
    </InfoSection>
  )
}
