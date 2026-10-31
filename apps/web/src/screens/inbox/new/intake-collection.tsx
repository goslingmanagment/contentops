import { formatNumber, type InboxGroup, type Instant } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { CollectionOption } from '@contentops/ui/components/collection-option'
import { ItemContextMenu, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { cn } from '@contentops/ui/lib/utils'
import { type KeyboardEvent, type MouseEvent, type Ref, useId } from 'react'
import { useCurrentModel } from '@/shell/model/model-context'
import type { InboxView } from '../search'
import { useSourceName } from '../shared/disk-line'
import { groupStateView, metaLine } from '../shared/group-texts'
import { INTAKE_ROW_COLUMNS, INTAKE_ROW_SPAN, IntakeRow } from './intake-row'
import type { IntakeSection } from './intake-sections'
import { IntakeTile } from './intake-tile'

interface IntakeCollectionProps {
  sections: readonly IntakeSection[]
  view: InboxView
  selectedKeys: ReadonlySet<string>
  focusIndex: number
  now: Instant
  channelName: (id: string) => string
  /** Готовые группы, которые можно принять пакетом: ссылка «Принять все 5». */
  readyBatch: { groups: readonly InboxGroup[]; pending: boolean; onAccept: () => void }
  /** Правый клик — то же меню, что «⋯» в панели (§3.6). */
  menuFor: (group: InboxGroup) => ItemMenuModel
  onItemClick: (index: number, event: MouseEvent) => void
  onItemDoubleClick: (index: number) => void
  onToggle: (key: string) => void
  onSelectSection: (section: IntakeSection) => void
  onKeyDown: (event: KeyboardEvent) => void
  listRef: Ref<HTMLDivElement>
  onScroll: (offset: number) => void
}

/** «Принять все 5»; если готовы не все — «Принять 4»; одна — просто «Принять». */
function acceptAllLabel(acceptable: number, inSection: number): string {
  if (acceptable === 1) {
    return 'Принять'
  }
  return acceptable === inSection
    ? `Принять все ${formatNumber(acceptable)}`
    : `Принять ${formatNumber(acceptable)}`
}

export function optionId(listId: string, index: number): string {
  return `${listId}-${index}`
}

/**
 * Группы «Нового» разделами (DESIGN §4.8). Фокус держит сам список
 * (`aria-activedescendant`), стрелки, цифры и `Space` слушает он же. Групп в «Приехало»
 * десятки, а не сотни (§6: до 17 пачек в пиковый день), поэтому сетка не виртуальная.
 * В виде «Список» все разделы — одна сетка: колонки строк стоят ровно от раздела к разделу.
 */
export function IntakeCollection({
  sections,
  view,
  selectedKeys,
  focusIndex,
  now,
  channelName,
  readyBatch,
  menuFor,
  onItemClick,
  onItemDoubleClick,
  onToggle,
  onSelectSection,
  onKeyDown,
  listRef,
  onScroll,
}: IntakeCollectionProps) {
  const listId = useId()
  const cloud = useSourceName(useCurrentModel().code)
  const multi = selectedKeys.size > 1
  return (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Приехало"
      aria-multiselectable
      aria-activedescendant={optionId(listId, focusIndex)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      className="group/collection -mx-7 min-h-0 flex-1 select-none overflow-y-auto px-7 pt-1 pb-8 outline-none"
    >
      <div className={view === 'list' ? cn('-mx-2 grid', INTAKE_ROW_COLUMNS) : undefined}>
        {sections.map((section) => {
          const headingId = `${listId}-${section.key}`
          return (
            // biome-ignore lint/a11y/useSemanticElements: раздел списка по ARIA — group внутри listbox; fieldset — для форм
            <section
              key={section.key}
              role="group"
              aria-labelledby={headingId}
              className={cn('mt-5 first:mt-2', view === 'list' && INTAKE_ROW_SPAN)}
            >
              <header
                className={cn(
                  'mb-2 flex h-9 items-center gap-3 px-2',
                  view === 'list' ? 'col-span-full' : '-mx-2',
                )}
              >
                <button
                  id={headingId}
                  type="button"
                  tabIndex={-1}
                  onClick={() => onSelectSection(section)}
                  className="rounded-sm text-left text-lg"
                >
                  {section.title}
                  {section.counted ? (
                    <span className="ml-1.5 font-normal text-ink-3 text-sm tabular-nums">
                      {formatNumber(section.groups.length)}
                    </span>
                  ) : null}
                </button>
                {section.key === 'ready' && readyBatch.groups.length > 0 ? (
                  <Button
                    variant="link"
                    size="sm"
                    pending={readyBatch.pending}
                    onClick={readyBatch.onAccept}
                    className="ml-auto"
                  >
                    {acceptAllLabel(readyBatch.groups.length, section.groups.length)}
                  </Button>
                ) : null}
              </header>
              <div
                data-intake-grid=""
                className={cn(
                  view === 'large'
                    ? '-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-2'
                    : cn('gap-y-0.5', INTAKE_ROW_SPAN),
                )}
              >
                {section.groups.map((group, offset) => {
                  const index = section.start + offset
                  const selected = selectedKeys.has(group.id)
                  const state = groupStateView(group, channelName, false, cloud)
                  return (
                    <CollectionOption
                      key={group.id}
                      id={optionId(listId, index)}
                      index={index}
                      selected={selected}
                      focused={index === focusIndex}
                      onItemClick={onItemClick}
                      onItemDoubleClick={onItemDoubleClick}
                      className={
                        view === 'large' ? 'rounded-2xl' : cn('rounded-lg', INTAKE_ROW_SPAN)
                      }
                    >
                      <ItemContextMenu menu={menuFor(group)}>
                        {/* Правый клик сначала выбирает группу: меню действует на неё. */}
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: это триггер меню Radix; с клавиатуры то же меню — «⋯» в панели */}
                        <div
                          className={view === 'large' ? 'h-full' : INTAKE_ROW_SPAN}
                          onContextMenu={(event) => {
                            if (!selected) {
                              onItemClick(index, event)
                            }
                          }}
                        >
                          {view === 'large' ? (
                            <IntakeTile
                              group={group}
                              meta={metaLine(group, now)}
                              state={state}
                              selected={selected}
                              multi={multi}
                              onToggle={onToggle}
                            />
                          ) : (
                            <IntakeRow
                              group={group}
                              state={state}
                              selected={selected}
                              multi={multi}
                              onToggle={onToggle}
                            />
                          )}
                        </div>
                      </ItemContextMenu>
                    </CollectionOption>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
