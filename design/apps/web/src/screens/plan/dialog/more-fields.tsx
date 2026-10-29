import type { PersonRef } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { Input } from '@contentops/ui/components/input'
import { Label } from '@contentops/ui/components/label'
import { ChevronDownIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { TimeField } from '../shared/time-field'

const BY_PAGE = 'page'

interface MoreFieldsProps {
  time: string | null
  onTimeChange: (time: string | null) => void
  assignee: string | null
  onAssigneeChange: (assignee: string | null) => void
  note: string
  onNoteChange: (note: string) => void
  people: readonly PersonRef[]
  /** Кто выкладывает по странице: «по странице · Диана». */
  pageAssignee: PersonRef | undefined
}

/**
 * «Ещё ▾» (DESIGN §4.13): время (подставлено из нормы выбранного места; пустое — «любое
 * время»), кто выкладывает (из страницы), заметка. Закрыто по умолчанию: подставленное
 * почти всегда верно.
 */
export function MoreFields({
  time,
  onTimeChange,
  assignee,
  onAssigneeChange,
  note,
  onNoteChange,
  people,
  pageAssignee,
}: MoreFieldsProps) {
  const [open, setOpen] = useState(false)
  const noteId = useId()
  const assigneeId = useId()
  return (
    <section className="flex flex-col gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="-ml-2.5 self-start text-muted-foreground [&_svg]:transition-transform aria-expanded:[&_svg]:rotate-180"
      >
        Ещё
        <ChevronDownIcon />
      </Button>
      {open ? (
        <div className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 duration-120 animate-in fade-in-0">
          <span className="text-ink-3 text-sm">Время</span>
          <span className="flex">
            <TimeField value={time} label="Время" onChange={onTimeChange} />
          </span>
          <span id={assigneeId} className="text-ink-3 text-sm">
            Кто выкладывает
          </span>
          <ChoiceChips
            labelledBy={assigneeId}
            value={assignee ?? BY_PAGE}
            onChange={(next) => onAssigneeChange(next === BY_PAGE ? null : next)}
            choices={[
              {
                value: BY_PAGE,
                label: pageAssignee ? `По странице · ${pageAssignee.name}` : 'По странице',
              },
              ...people
                .filter((person) => person.id !== pageAssignee?.id)
                .map((person) => ({ value: person.id, label: person.name })),
            ]}
          />
          <Label htmlFor={noteId} className="text-ink-3 text-sm">
            Заметка
          </Label>
          <Input
            id={noteId}
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="Что важно для этой строки"
          />
        </div>
      ) : null}
    </section>
  )
}
