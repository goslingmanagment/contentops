import {
  type CatalogEntry,
  formatDate,
  formatNumber,
  formatShortDay,
  formatWeekdayShort,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { cn } from '@contentops/ui/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { CalendarPlusIcon } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { useForm } from 'react-hook-form'
import { useToday } from '@/data/api-session'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { useCreateRows } from '../shared/actions/use-create-rows'
import { rowsWord } from '../shared/plan-text'
import { checkLinesFor, type RowNote, useBatchCheck } from './check-line'
import { DialogLayout } from './dialog-layout'
import { submitOnCtrlEnter } from './form-parts'
import {
  cellKey,
  existingRelease,
  parseCell,
  RELEASE_SURFACE_LABEL,
  RELEASE_SURFACES,
  type ReleaseForm,
  ReleaseFormSchema,
  releaseDefaults,
  releaseRows,
} from './release-rules'
import { blockedReason } from './rules'
import { SlotControls } from './slot-controls'
import type { DialogData } from './use-dialog-data'

interface ReleaseFormViewProps {
  entry: CatalogEntry
  data: DialogData
  preset: PlanDialogPreset
  tabs: ReactNode
  left: ReactNode
  onDone: () => void
}

/**
 * Вкладка «Выпуск PPV» (DESIGN §4.13): матрица «страницы × стена / рассылка / сториз-тизер /
 * vault», у столбца день и время. Выпуск ставится целиком или не ставится вовсе и
 * считается один раз.
 */
export function ReleaseFormView({ entry, data, preset, tabs, left, onDone }: ReleaseFormViewProps) {
  const today = useToday()
  const formId = useId()
  const form = useForm<ReleaseForm>({
    resolver: zodResolver(ReleaseFormSchema),
    defaultValues: releaseDefaults({
      entry,
      accounts: data.model.accounts,
      norms: data.norms,
      summaries: data.summaries?.byItem.get(entry.id) ?? [],
      today: data.today,
      date: preset.date,
      releases: data.releases,
    }),
  })
  const values = form.watch()
  const rows = releaseRows(entry, values)
  const check = useBatchCheck(rows)
  const already = existingRelease(entry, data.releases)
  const alreadyText = already
    ? `Выпуск уже в плане: ${formatShortDay(already.date)}, ${rowsWord(already.row_ids.length)}`
    : null
  const noteByCell = new Map(
    values.cells
      .filter((key) => parseCell(key) !== null)
      .map((key, index) => [key, check.notes[index] ?? null]),
  )
  const create = useCreateRows({ onCreated: onDone })
  const checked = new Set(values.cells)
  const pages = new Set(rows.map((row) => row.account)).size
  const firstDay = rows.map((row) => row.date).sort()[0]

  const toggle = (key: string, on: boolean) => {
    const next = on ? [...values.cells, key] : values.cells.filter((cell) => cell !== key)
    form.setValue('cells', next)
  }

  return (
    <form
      id={formId}
      className="contents"
      onSubmit={form.handleSubmit((submitted) =>
        create.createRelease({
          item_id: entry.id,
          cells: submitted.cells.flatMap((key) => {
            const cell = parseCell(key)
            return cell ? [{ ...cell, ...submitted.slots[cell.surface] }] : []
          }),
        }),
      )}
      onKeyDown={submitOnCtrlEnter}
    >
      <DialogLayout
        title="В план"
        description={`Выпуск ${entry.id}`}
        tabs={tabs}
        left={left}
        checkLines={checkLinesFor(rows.length)}
        check={
          alreadyText && (rows.length === 0 || check.summary?.tone === 'muted')
            ? { tone: 'muted', text: alreadyText, thresholdUnset: false }
            : check.summary
        }
        summary={
          rows.length > 0
            ? `Выпуск ${entry.id} · ${rowsWord(rows.length)} на ${formatNumber(pages)} ${plural(pages, ['странице', 'страницах', 'страницах'])}${firstDay ? ` · с ${formatWeekdayShort(firstDay)} ${formatDate(firstDay, today)}` : ''}`
            : 'Отметьте ячейки'
        }
        submit={
          <Button type="submit" form={formId} disabled={rows.length === 0} pending={create.pending}>
            <CalendarPlusIcon />
            {rows.length > 0 ? `Поставить выпуск: ${rowsWord(rows.length)}` : 'Поставить выпуск'}
          </Button>
        }
      >
        <table className="w-full table-fixed border-separate border-spacing-0 text-base">
          <thead>
            <tr>
              <th className="w-20" aria-label="Страница" />
              {RELEASE_SURFACES.map((surface) => (
                <th
                  key={surface}
                  scope="col"
                  className="px-1 pb-2 text-left align-bottom font-normal"
                >
                  <span className="mb-1.5 block whitespace-nowrap text-ink-3 text-sm">
                    {RELEASE_SURFACE_LABEL[surface]}
                  </span>
                  <SlotControls
                    label={RELEASE_SURFACE_LABEL[surface]}
                    date={values.slots[surface].date}
                    time={values.slots[surface].time}
                    today={data.today}
                    onDateChange={(date) => form.setValue(`slots.${surface}.date`, date)}
                    onTimeChange={(time) => form.setValue(`slots.${surface}.time`, time)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.model.accounts.map((account) => {
              const reason = blockedReason(entry, account)
              return (
                <tr key={account.code} className="h-10">
                  <th
                    scope="row"
                    title={reason ?? undefined}
                    className={cn(
                      'border-border border-t pr-2 text-left font-normal',
                      reason && 'text-ink-3',
                    )}
                  >
                    {account.label}
                  </th>
                  {RELEASE_SURFACES.map((surface) => {
                    const key = cellKey(account.code, surface)
                    const note = noteByCell.get(key) ?? null
                    return (
                      <td key={surface} className="border-border border-t px-1">
                        <span className="flex items-center gap-1.5">
                          <Checkbox
                            checked={checked.has(key)}
                            disabled={reason !== null}
                            onCheckedChange={(on) => toggle(key, on === true)}
                            aria-label={`${account.label} · ${RELEASE_SURFACE_LABEL[surface]}`}
                          />
                          {note ? <CellNote note={note} /> : null}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {data.model.accounts.some((account) => blockedReason(entry, account)) ? (
          <p className="text-ink-3 text-sm">OnlyFans — нельзя: второй человек в кадре</p>
        ) : null}
      </DialogLayout>
    </form>
  )
}

/** Янтарная (или красная) точка у ячейки, которую задела проверка; фраза — в подсказке. */
function CellNote({ note }: { note: RowNote }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={note.text}
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            note.tone === 'blocked' ? 'bg-destructive' : 'bg-attention',
          )}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{note.text}</TooltipContent>
    </Tooltip>
  )
}
