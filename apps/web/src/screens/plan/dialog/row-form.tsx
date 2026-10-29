import {
  type Account,
  type CatalogEntry,
  formatNumber,
  type PageSummaryEntry,
  type SurfaceKind,
  weekStart,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { Label } from '@contentops/ui/components/label'
import { zodResolver } from '@hookform/resolvers/zod'
import { CalendarPlusIcon, CheckIcon } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useItem } from '@/data/object'
import { accountOf } from '@/lib/words'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { useCreateRows } from '../shared/actions/use-create-rows'
import { DayPicker } from '../shared/day-picker'
import { checkLinesFor, useCheckSummary } from './check-line'
import { DialogLayout } from './dialog-layout'
import { blockedHint, Field, PagePills, SurfaceChoice, submitOnCtrlEnter } from './form-parts'
import { FypVersionsLine, pickVersions } from './fyp-versions'
import { MoreFields } from './more-fields'
import { buildRows, type RowForm, RowFormSchema, rowsSummary } from './row-form-schema'
import {
  allowedSurfaces,
  blockedReason,
  defaultPages,
  defaultSurface,
  normOf,
  normTime,
  pageBlockReason,
} from './rules'
import { type DialogData, firstGapDay, gapDays } from './use-dialog-data'

interface RowFormViewProps {
  entry: CatalogEntry
  data: DialogData
  preset: PlanDialogPreset
  title: string
  tabs?: ReactNode
  left: ReactNode
  onDone: () => void
}

function summariesOf(data: DialogData, entry: CatalogEntry): readonly PageSummaryEntry[] {
  return data.summaries?.byItem.get(entry.id) ?? []
}

function initialForm(entry: CatalogEntry, data: DialogData, preset: PlanDialogPreset): RowForm {
  const allowed = allowedSurfaces(entry.type)
  const surface: SurfaceKind =
    preset.surface && allowed.includes(preset.surface)
      ? preset.surface
      : (defaultSurface(entry) ?? 'wall')
  const accounts = preset.accounts
    ? preset.accounts.filter((code) => {
        const account = accountOf(data.model.accounts, code)
        return account !== undefined && blockedReason(entry, account) === null
      })
    : defaultPages({
        entry,
        accounts: data.model.accounts,
        surface,
        norms: data.norms,
        summaries: summariesOf(data, entry),
      })
  const first = accounts[0]
  const level =
    (first ? normOf(data.norms, first)?.uniq_level : undefined) ??
    (first ? accountOf(data.model.accounts, first)?.uniq_level : undefined) ??
    'soft'
  return {
    accounts,
    surface,
    // Из ящика недели — первое пустое место в той неделе, а не в текущей.
    date:
      preset.date ??
      firstGapDay(data, accounts, surface, preset.week ? weekStart(preset.week) : data.today),
    time:
      preset.time !== undefined ? preset.time : first ? normTime(data.norms, first, surface) : null,
    assignee: null,
    note: '',
    level,
    reupload: preset.reupload ?? false,
  }
}

/**
 * Вкладка «Строка» (DESIGN §4.13): страницы, куда, день, версии фупа, «Залить заново»,
 * «Ещё ▾». Строка проверки — тот же `rows:check`, что у агента; «Поставить N» — одним
 * пакетом, всё или ничего.
 */
export function RowFormView({ entry, data, preset, title, tabs, left, onDone }: RowFormViewProps) {
  const formId = useId()
  const reuploadId = useId()
  const outside = preset.outside ?? false
  const form = useForm<RowForm>({
    resolver: zodResolver(RowFormSchema),
    defaultValues: initialForm(entry, data, preset),
  })
  const values = form.watch()
  const [rejected, setRejected] = useState<string | null>(null)
  const create = useCreateRows({
    onCreated: onDone,
    onRejected: (result) => setRejected(result.rejected[0]?.text ?? 'Не поставлено'),
  })

  const detail = useItem(data.model.code, entry.id)
  const picks = useMemo(
    () =>
      values.surface === 'fyp'
        ? pickVersions(detail.data?.fyp_versions ?? [], values.accounts)
        : [],
    [values.surface, values.accounts, detail.data],
  )
  // Время из нормы выбранного места, пока его не выбрали руками (§4.13).
  const timeTouched = Boolean(form.formState.dirtyFields.time)
  const timeOf = useMemo(
    () =>
      timeTouched
        ? undefined
        : (account: string) => normTime(data.norms, account, values.surface) ?? values.time,
    [timeTouched, data.norms, values.surface, values.time],
  )
  const rows = useMemo(
    () => buildRows({ entry, form: values, picks, outside, timeOf }),
    [entry, values, picks, outside, timeOf],
  )
  const check = useCheckSummary(rows)
  const summaryCheck = rejected
    ? { tone: 'blocked' as const, text: rejected, thresholdUnset: false }
    : check.summary

  const surfaces = allowedSurfaces(entry.type)
  const disabledReason = (account: Account) => pageBlockReason([entry], account, values.surface)
  const firstAccount = values.accounts[0]
  const pageAssigneeId = firstAccount
    ? accountOf(data.model.accounts, firstAccount)?.usual_assignee
    : null
  const pageAssignee = data.people.find((person) => person.id === pageAssigneeId)
  const chosenAssignee = values.assignee
    ? data.people.find((person) => person.id === values.assignee)
    : pageAssignee

  const changeSurface = (surface: SurfaceKind) => {
    form.setValue('surface', surface)
    const accounts = form.getValues('accounts').filter((code) => {
      const account = accountOf(data.model.accounts, code)
      return (
        account !== undefined && allowedSurfaces(entry.type, account.platform).includes(surface)
      )
    })
    form.setValue('accounts', accounts)
    const first = accounts[0]
    if (!timeTouched && first) {
      form.setValue('time', normTime(data.norms, first, surface))
    }
    setRejected(null)
  }

  const count = rows.length
  const verb = outside ? 'Отметить' : 'Поставить'
  // Без страницы — просто «Поставить», а итог говорит «Выберите страницу».
  const submitLabel = count > 0 ? `${verb} ${formatNumber(count)}` : verb

  return (
    <form
      id={formId}
      className="contents"
      onSubmit={form.handleSubmit((submitted) =>
        create.create(buildRows({ entry, form: submitted, picks, outside, timeOf })),
      )}
      onKeyDown={submitOnCtrlEnter}
    >
      <DialogLayout
        title={title}
        description={`${entry.id} · ${entry.title}`}
        tabs={tabs}
        left={left}
        check={summaryCheck}
        checkLines={checkLinesFor(rows.length)}
        summary={count > 0 ? rowsSummary(entry.id, values, chosenAssignee) : 'Выберите страницу'}
        submit={
          <Button type="submit" form={formId} disabled={count === 0} pending={create.pending}>
            {outside ? <CheckIcon /> : <CalendarPlusIcon />}
            {submitLabel}
          </Button>
        }
      >
        <Field
          label="Страницы"
          hint={blockedHint(data.model.accounts, (account) => blockedReason(entry, account))}
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
                    const first = next[0]
                    if (!timeTouched && first) {
                      form.setValue('time', normTime(data.norms, first, values.surface))
                    }
                    setRejected(null)
                  }}
                  disabledReason={disabledReason}
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
                onChange={changeSurface}
                labelledBy={labelId}
              />
            )}
          </Field>
        ) : null}
        <Field label="День">
          {() => (
            <Controller
              control={form.control}
              name="date"
              render={({ field }) => (
                <DayPicker
                  value={field.value}
                  onChange={(next) => {
                    field.onChange(next)
                    setRejected(null)
                  }}
                  today={data.today}
                  marked={gapDays(data.gaps, values.accounts, values.surface)}
                  label="День"
                />
              )}
            />
          )}
        </Field>
        {values.surface === 'fyp' && picks.length > 0 ? (
          <Controller
            control={form.control}
            name="level"
            render={({ field }) => (
              <FypVersionsLine
                accounts={data.model.accounts}
                picks={picks}
                level={field.value}
                onLevelChange={field.onChange}
              />
            )}
          />
        ) : null}
        {values.surface === 'vault' ? (
          <Controller
            control={form.control}
            name="reupload"
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={reuploadId}
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
                <Label htmlFor={reuploadId}>Залить заново (новый файл)</Label>
              </div>
            )}
          />
        ) : null}
        <MoreFields
          time={values.time}
          onTimeChange={(time) => form.setValue('time', time, { shouldDirty: true })}
          assignee={values.assignee}
          onAssigneeChange={(assignee) => form.setValue('assignee', assignee)}
          note={values.note}
          onNoteChange={(note) => form.setValue('note', note)}
          people={data.people}
          pageAssignee={pageAssignee}
        />
      </DialogLayout>
    </form>
  )
}
