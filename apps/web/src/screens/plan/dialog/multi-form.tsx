import {
  AccountCodeSchema,
  type CatalogEntry,
  formatNumber,
  IsoWeekSchema,
  LocalDateSchema,
  plural,
  SurfaceKindSchema,
  type UniqLevel,
  UniqLevelSchema,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { zodResolver } from '@hookform/resolvers/zod'
import { CalendarPlusIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { useCreateRows } from '../shared/actions/use-create-rows'
import { DayPicker } from '../shared/day-picker'
import { pagesLabel, rowsWord } from '../shared/plan-text'
import { type CheckSummary, checkLinesFor, useBatchCheck } from './check-line'
import { DialogLayout } from './dialog-layout'
import { blockedHint, Field, PagePills, SurfaceChoice, submitOnCtrlEnter } from './form-parts'
import { FypLevelSelect } from './fyp-versions'
import { blockedReason, commonSurfaces, normExpects, normOf, pageBlockReason } from './rules'
import { ModeChoice, WeekChoice } from './spread-fields'
import { SelectedList, SpreadPreview } from './spread-preview'
import type { DialogData } from './use-dialog-data'
import { useSpread } from './use-spread'

const MultiFormSchema = z.object({
  accounts: z.array(AccountCodeSchema).min(1, 'Выберите страницу'),
  surface: SurfaceKindSchema,
  week: IsoWeekSchema,
  mode: z.enum(['gaps', 'day']),
  date: LocalDateSchema,
  level: UniqLevelSchema,
})
type MultiForm = z.infer<typeof MultiFormSchema>

interface MultiFormViewProps {
  entries: readonly CatalogEntry[]
  data: DialogData
  preset: PlanDialogPreset
  onDone: () => void
}

function initialForm(
  entries: readonly CatalogEntry[],
  data: DialogData,
  preset: PlanDialogPreset,
): MultiForm {
  const surfaces = commonSurfaces(entries.map((entry) => entry.type))
  const surface =
    preset.surface && surfaces.includes(preset.surface) ? preset.surface : (surfaces[0] ?? 'wall')
  const allowed = (code: string) => {
    const account = data.model.accounts.find((candidate) => candidate.code === code)
    return account !== undefined && pageBlockReason(entries, account, surface) === null
  }
  const accounts = (
    preset.accounts ??
    data.model.accounts
      .filter((account) => normExpects(data.norms, account.code, surface))
      .map((account) => account.code)
  ).filter(allowed)
  const first = accounts[0]
  const level: UniqLevel = (first ? normOf(data.norms, first)?.uniq_level : undefined) ?? 'soft'
  return {
    accounts,
    surface,
    week: preset.week ?? data.weeks.thisWeek,
    // Подставленный день — «Все на один день» (§6.5: «Fansly 2 · vault · сегодня»);
    // без дня — по пустым местам нормы недели.
    mode: preset.date ? 'day' : 'gaps',
    date: preset.date ?? data.today,
    level,
  }
}

/** Пакет не прошёл: какая строка и почему (всё или ничего, §3.3). */
function rejectedSummary(rejected: ReadonlyMap<string, string>): CheckSummary | null {
  const [first] = rejected.values()
  return first === undefined
    ? null
    : { tone: 'blocked', text: `Не поставлено: ${first}`, thresholdUnset: false }
}

/**
 * Несколько объектов (DESIGN §4.13): страницы, куда, неделя, уровень версий фупа и
 * «По пустым местам недели / Все на один день»; ниже предпросмотр строк с галочками и
 * своей пометкой проверки. «Поставить 14» — всё или ничего.
 */
export function MultiFormView({ entries, data, preset, onDone }: MultiFormViewProps) {
  const formId = useId()
  const form = useForm<MultiForm>({
    resolver: zodResolver(MultiFormSchema),
    defaultValues: initialForm(entries, data, preset),
  })
  const values = form.watch()
  const spread = useSpread(entries, data, values)
  const check = useBatchCheck(spread.newRows)
  const [rejected, setRejected] = useState<ReadonlyMap<string, string>>(() => new Map())
  const create = useCreateRows({
    onCreated: onDone,
    onRejected: (result) =>
      setRejected(
        new Map(
          result.rejected.flatMap((entry) => {
            const row = spread.chosen[entry.index]
            return row ? [[row.key, entry.text] as const] : []
          }),
        ),
      ),
  })
  const noteOf = new Map(spread.chosen.map((row, index) => [row.key, check.notes[index] ?? null]))
  const surfaces = commonSurfaces(entries.map((entry) => entry.type))
  const chosenPages = data.model.accounts.filter((account) =>
    values.accounts.includes(account.code),
  )
  const count = spread.newRows.length

  return (
    <form
      id={formId}
      className="contents"
      onSubmit={form.handleSubmit(() => create.create(spread.newRows))}
      onKeyDown={submitOnCtrlEnter}
    >
      <DialogLayout
        title="В план"
        description={`${formatNumber(entries.length)} ${plural(entries.length, ['объект', 'объекта', 'объектов'])}`}
        left={<SelectedList entries={entries} />}
        check={rejectedSummary(rejected) ?? check.summary}
        checkLines={checkLinesFor(spread.newRows.length)}
        summary={`${rowsWord(count)} · ${pagesLabel(chosenPages)}`}
        submit={
          <Button type="submit" form={formId} disabled={count === 0} pending={create.pending}>
            <CalendarPlusIcon />
            {count > 0 ? `Поставить ${formatNumber(count)}` : 'Поставить'}
          </Button>
        }
      >
        <Field
          label="Страницы"
          hint={blockedHint(
            data.model.accounts,
            (account) =>
              entries.map((entry) => blockedReason(entry, account)).find(Boolean) ?? null,
          )}
        >
          {(labelId) => (
            <Controller
              control={form.control}
              name="accounts"
              render={({ field }) => (
                <PagePills
                  accounts={data.model.accounts}
                  value={field.value}
                  onChange={(next) => {
                    field.onChange(next)
                    setRejected(new Map())
                  }}
                  disabledReason={(account) => pageBlockReason(entries, account, values.surface)}
                  labelledBy={labelId}
                />
              )}
            />
          )}
        </Field>
        {surfaces.length > 1 ? (
          <Field label="Куда">
            {(labelId) => (
              <SurfaceChoice
                surfaces={surfaces}
                value={values.surface}
                onChange={(surface) => form.setValue('surface', surface)}
                labelledBy={labelId}
              />
            )}
          </Field>
        ) : null}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-5">
          <WeekChoice
            value={values.week}
            thisWeek={data.weeks.thisWeek}
            nextWeek={data.weeks.nextWeek}
            onChange={(week) => form.setValue('week', week)}
          />
          <ModeChoice value={values.mode} onChange={(mode) => form.setValue('mode', mode)} />
          {values.surface === 'fyp' ? (
            <Field label="Версии">
              {() => (
                <FypLevelSelect
                  value={values.level}
                  onChange={(level) => form.setValue('level', level)}
                />
              )}
            </Field>
          ) : null}
        </div>
        {values.mode === 'day' ? (
          <Field label="День">
            {() => (
              <DayPicker
                value={values.date}
                onChange={(date) => form.setValue('date', date)}
                today={data.today}
                label="День"
              />
            )}
          </Field>
        ) : null}
        <Field label={`Предпросмотр · ${rowsWord(count)}`}>
          {() => (
            <SpreadPreview
              rows={spread.rows}
              entries={entries}
              accounts={data.model.accounts}
              level={values.surface === 'fyp' ? values.level : null}
              isChecked={spread.isChecked}
              onCheckedChange={spread.setChecked}
              noteOf={(row) => noteOf.get(row.key) ?? null}
              rejectedOf={(row) => rejected.get(row.key)}
            />
          )}
        </Field>
      </DialogLayout>
    </form>
  )
}
