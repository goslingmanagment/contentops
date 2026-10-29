import type { InboxGroup } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { cn } from '@contentops/ui/lib/utils'
import { groupMosaic } from '../shared/draft-cover'
import { groupSource } from '../shared/group-source'
import { GroupStateLine } from '../shared/group-state-line'
import { type GroupStateView, hintText, TYPE_WORD } from '../shared/group-texts'
import { ThumbStack } from '../shared/thumb-stack'

interface IntakeRowProps {
  group: InboxGroup
  state: GroupStateView
  selected: boolean
  multi: boolean
  onToggle: (key: string) => void
}

/**
 * Колонки списка (вид «Список»): галочка, стопка, название с типом и путём, состояние с
 * подсказкой под ним. Название берёт свою ширину, пока хватает места, и не уже 10rem;
 * состоянию всегда хватает на самое длинное слово; подсказка — всё, что осталось справа,
 * и обрезается первой. Путь и подсказка ширину колонок не задают (`contain`). Строки
 * всех разделов берут колонки через `subgrid` и стоят ровно.
 */
export const INTAKE_ROW_COLUMNS =
  'grid-cols-[1.25rem_4.25rem_minmax(10rem,max-content)_minmax(max-content,1fr)] gap-x-3'

/** Строка и её обёртки занимают все колонки раздела и делят их (`subgrid`). */
export const INTAKE_ROW_SPAN = 'col-span-full grid grid-cols-subgrid'

/**
 * Строка группы (вид «Список», 64): стопка из трёх миниатюр 48 × 64, название, под ним
 * тип чипом и путь Я.Диска; справа состояние, под ним подсказка — она обрезается первой.
 * «Изменён после снимка» уже сказано в состоянии, подсказкой не повторяется.
 */
export function IntakeRow({ group, state, selected, multi, onToggle }: IntakeRowProps) {
  const source = groupSource(group)
  const hint = group.hints.find((candidate) => candidate.kind !== 'changed_after_snapshot')
  return (
    <div
      data-selected={selected}
      className={cn(
        'group/row h-16 min-w-0 items-center rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint',
        INTAKE_ROW_SPAN,
      )}
    >
      <span
        className={cn(
          'flex size-5 items-center justify-center opacity-0 transition-opacity duration-120 group-hover/row:opacity-100',
          selected && multi && 'opacity-100',
        )}
      >
        <Checkbox
          checked={selected}
          aria-label={`Выбрать «${group.title}»`}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(group.id)
          }}
        />
      </span>
      <ThumbStack tiles={groupMosaic(group)} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium" title={group.title}>
          {group.title}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {group.fields.type ? <Badge>{TYPE_WORD[group.fields.type]}</Badge> : null}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-ink-3 [contain:inline-size]',
              source.path ? 'font-mono text-xs' : 'text-sm',
            )}
            title={source.text}
          >
            {source.text}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-col justify-center gap-0.5">
        <span className="flex items-center whitespace-nowrap">
          <GroupStateLine view={state} />
        </span>
        {hint ? (
          <span
            className="truncate text-ink-3 text-sm [contain:inline-size]"
            title={hintText(hint)}
          >
            {hintText(hint)}
          </span>
        ) : null}
      </span>
    </div>
  )
}
