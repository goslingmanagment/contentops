import {
  DISPUTE_KIND_LABEL,
  type Dispute,
  type DisputeKind,
  DisputeKindSchema,
  formatNumber,
  type LabelMapping,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronRightIcon } from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'
import { z } from 'zod'
import { useHistoryState } from '@/lib/use-history-state'
import { DisputeRow } from './dispute-row'
import { useLegacyActions } from './use-legacy-actions'

const OpenSchema = z.array(z.string())

interface DisputeGroup {
  kind: DisputeKind
  disputes: readonly Dispute[]
  unresolved: number
}

const isSettled = (dispute: Dispute) => dispute.resolved !== null || dispute.postponed !== null

/**
 * Виды спорного в порядке нормы; пустые не показываются. Решённое до входа на экран стоит
 * в конце своей группы: при сотне случаев одного вида нерешённые идут подряд. Решённое
 * сейчас остаётся на месте и сереет (§1.7).
 */
function groupsOf(
  disputes: readonly Dispute[],
  settledAtEntry: ReadonlySet<string>,
): DisputeGroup[] {
  return DisputeKindSchema.options.flatMap((kind) => {
    const inKind = disputes.filter((dispute) => dispute.kind === kind)
    const ordered = [
      ...inKind.filter((dispute) => !settledAtEntry.has(dispute.id)),
      ...inKind.filter((dispute) => settledAtEntry.has(dispute.id)),
    ]
    return inKind.length > 0
      ? [{ kind, disputes: ordered, unresolved: inKind.filter((item) => !item.resolved).length }]
      : []
  })
}

/** Где нужен человек: нерешённая строка или свёрнутая группа, где есть нерешённое. */
export const OPEN_CASE =
  '[data-dispute-row][data-settled="false"], [data-dispute-group][aria-expanded="false"]:not([data-unresolved="0"])'

/** Стрелки вверх и вниз — между строками спорного, как в любом списке (§3.12). */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.code !== 'ArrowDown' && event.code !== 'ArrowUp') {
    return
  }
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[data-dispute-row], [data-dispute-group]'),
  )
  const active = document.activeElement
  const current = active instanceof HTMLElement ? rows.indexOf(active) : -1
  const next = rows[current + (event.code === 'ArrowDown' ? 1 : -1)]
  if (next) {
    event.preventDefault()
    next.focus()
  }
}

/**
 * После решения фокус идёт к следующему случаю, где нужен человек (§7.8): к нерешённой
 * строке ниже или к заголовку следующей свёрнутой группы.
 */
function focusNextCase(row: HTMLElement) {
  const list = row.closest('[data-dispute-list]')
  if (!list) {
    return
  }
  const candidates = Array.from(list.querySelectorAll<HTMLElement>(OPEN_CASE))
  const next = candidates.find(
    (candidate) =>
      candidate !== row &&
      row.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
  next?.focus()
}

/** «Метки из имени», чья метка уже со страницей в карточке: их решает карточка. */
function boundByLabels(
  disputes: readonly Dispute[],
  labels: readonly LabelMapping[],
): readonly Dispute[] {
  const mapped = new Set(
    labels.filter((label) => label.target !== null).map((label) => label.label),
  )
  return disputes.filter(
    (dispute) =>
      dispute.kind === 'label_from_name' &&
      !dispute.resolved &&
      dispute.label !== null &&
      mapped.has(dispute.label),
  )
}

interface DisputeGroupsProps {
  disputes: readonly Dispute[]
  /** Карточка «Метки → страницы»: по ней «Метки из имени» привязываются все сразу. */
  labels: readonly LabelMapping[]
}

/**
 * «Спорное · 38» (DESIGN §4.9): группы по виду, свёрнуты, с числом. Раскрытые группы и
 * строки живут в `history.state`: «Назад» возвращает их как были.
 */
export function DisputeGroups({ disputes, labels }: DisputeGroupsProps) {
  const actions = useLegacyActions()
  const [openGroups, setOpenGroups] = useHistoryState('legacy:groups', OpenSchema, () => [])
  const [openRows, setOpenRows] = useHistoryState('legacy:rows', OpenSchema, () => [])
  const toggle = (list: readonly string[], key: string) =>
    list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
  const unresolved = disputes.filter((dispute) => !dispute.resolved).length
  const [settledAtEntry] = useState(
    () => new Set(disputes.filter(isSettled).map((dispute) => dispute.id)),
  )

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-lg">
        Спорное
        <span className="ml-1.5 font-normal text-ink-3 text-sm tabular-nums">
          {formatNumber(unresolved)}
        </span>
      </h2>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: стрелки ходят по строкам внутри */}
      <div onKeyDown={moveFocus} data-dispute-list="" className="-mx-2 flex flex-col">
        {groupsOf(disputes, settledAtEntry).map((group) => {
          const open = openGroups.includes(group.kind)
          const byLabels =
            group.kind === 'label_from_name' ? boundByLabels(group.disputes, labels) : []
          return (
            <div key={group.kind} className="flex flex-col">
              {/* Заголовок группы закреплён: в длинной группе видно, чей это случай. */}
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-background">
                <button
                  type="button"
                  data-dispute-group=""
                  data-unresolved={group.unresolved}
                  aria-expanded={open}
                  onClick={() => setOpenGroups((current) => toggle(current, group.kind))}
                  className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent"
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      'size-4 shrink-0 text-ink-3 transition-transform duration-120',
                      open && 'rotate-90',
                    )}
                  />
                  <span className="font-medium">{DISPUTE_KIND_LABEL[group.kind]}</span>
                  <span className="text-ink-3 text-sm tabular-nums">
                    {formatNumber(group.unresolved)}
                  </span>
                </button>
                {byLabels.length > 0 ? (
                  <Button
                    variant="link"
                    size="sm"
                    disabled={actions.resolving}
                    onClick={() => actions.bindByLabels(byLabels)}
                    className="ml-auto"
                  >
                    Привязать все {formatNumber(byLabels.length)} по карточке
                  </Button>
                ) : null}
              </div>
              {open ? (
                <div className="flex flex-col pb-2 pl-6">
                  {group.disputes.map((dispute) => (
                    <DisputeRow
                      key={dispute.id}
                      dispute={dispute}
                      open={openRows.includes(dispute.id)}
                      pending={actions.resolving}
                      onToggle={() => setOpenRows((current) => toggle(current, dispute.id))}
                      onChoose={(option, folders, row, extra) => {
                        actions.resolve(dispute.id, option.key, dispute.title, folders, extra)
                        focusNextCase(row)
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}
