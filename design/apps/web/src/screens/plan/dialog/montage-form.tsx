import {
  type AccountCode,
  AccountCodeSchema,
  type CatalogEntry,
  formatDuration,
  type ItemFile,
  LocalDateSchema,
  LocalTimeSchema,
  type NewPlanRow,
  type SurfaceKind,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { Label } from '@contentops/ui/components/label'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { zodResolver } from '@hookform/resolvers/zod'
import { CalendarPlusIcon } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { useItem } from '@/data/object'
import { filesWord } from '@/lib/words'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { useCreateRows } from '../shared/actions/use-create-rows'
import { DayPicker } from '../shared/day-picker'
import { slotText } from '../shared/plan-text'
import { useCheckSummary } from './check-line'
import { DialogLayout } from './dialog-layout'
import { Field, PagePills, submitOnCtrlEnter } from './form-parts'
import { pagesWord } from './row-form-schema'
import { normExpects, normTime, pageBlockReason } from './rules'
import { type DialogData, firstGapDay, gapDays } from './use-dialog-data'

const EXPECTED = ['fyp', 'ppv', 'teaser'] as const
const EXPECTED_LABEL: Record<(typeof EXPECTED)[number], string> = {
  fyp: 'фуп',
  ppv: 'PPV',
  teaser: 'тизер',
}
/** Куда встанет то, что выйдет из монтажа: фуп — в ленту, PPV — на стену, тизер — в сториз. */
const EXPECTED_SURFACE: Record<(typeof EXPECTED)[number], SurfaceKind> = {
  fyp: 'fyp',
  ppv: 'wall',
  teaser: 'story',
}

const MontageFormSchema = z.object({
  expected: z.enum(EXPECTED),
  files: z.array(z.string()).min(1, 'Отметьте файлы съёмки'),
  accounts: z.array(AccountCodeSchema).min(1, 'Выберите страницу'),
  date: LocalDateSchema,
  time: LocalTimeSchema.nullable(),
})
type MontageForm = z.infer<typeof MontageFormSchema>

interface MontageFormViewProps {
  entry: CatalogEntry
  data: DialogData
  preset: PlanDialogPreset
  left: ReactNode
  onDone: () => void
}

function montageRows(entry: CatalogEntry, form: MontageForm): NewPlanRow[] {
  return form.accounts.map((account) => ({
    item_id: null,
    account,
    surface: EXPECTED_SURFACE[form.expected],
    date: form.date,
    time: form.time,
    fyp_version: null,
    assignee: null,
    note: null,
    requires_new_upload: false,
    awaiting_montage: { from_item: entry.id, expected_type: form.expected, file_keys: form.files },
    marked: null,
  }))
}

/**
 * Страница по умолчанию: первая, где норма ждёт это место и где из этого сырья монтаж ещё не
 * ждут — иначе окно сразу предлагало бы повтор.
 */
export function montagePage(
  entry: CatalogEntry,
  data: Pick<DialogData, 'model' | 'norms' | 'rows'>,
  surface: SurfaceKind,
): AccountCode | undefined {
  const waiting = new Set(
    data.rows
      .filter(
        (row) =>
          row.cancelled === null &&
          row.surface === surface &&
          row.awaiting_montage?.from_item === entry.id,
      )
      .map((row) => row.account),
  )
  const expected = data.model.accounts.filter((account) =>
    normExpects(data.norms, account.code, surface),
  )
  return (expected.find((account) => !waiting.has(account.code)) ?? expected[0])?.code
}

/**
 * «В план» у сырья (DESIGN §4.13): вместо «Куда» — «Что выйдет», файлы съёмки галочками,
 * страница, день, время. Строка ждёт монтаж; само сырьё на стену и в vault не ставится.
 */
export function MontageFormView(props: MontageFormViewProps) {
  const detail = useItem(props.data.model.code, props.entry.id)
  if (!detail.data) {
    return (
      <DialogLayout
        title="В план"
        description={`Под монтаж из ${props.entry.id}`}
        left={props.left}
        check={null}
        summary=""
        submit={null}
      >
        <ListRowSkeleton height={52} thumb="none" />
      </DialogLayout>
    )
  }
  return (
    <MontageFormBody
      {...props}
      videos={detail.data.files.filter((file) => file.media === 'video')}
    />
  )
}

function MontageFormBody({
  entry,
  data,
  preset,
  left,
  onDone,
  videos,
}: MontageFormViewProps & { videos: readonly ItemFile[] }) {
  const formId = useId()
  const expected = entry.raw_purpose === 'ppv' ? 'ppv' : 'fyp'
  const surface = EXPECTED_SURFACE[expected]
  const firstPage = preset.accounts?.[0] ?? montagePage(entry, data, surface)
  const form = useForm<MontageForm>({
    resolver: zodResolver(MontageFormSchema),
    defaultValues: {
      expected,
      files: videos.map((file) => file.key),
      accounts: firstPage ? [firstPage] : [],
      date: preset.date ?? firstGapDay(data, firstPage ? [firstPage] : [], surface),
      time: firstPage ? normTime(data.norms, firstPage, surface) : null,
    },
  })
  const values = form.watch()
  const files = values.files
  const rows = files.length > 0 ? montageRows(entry, values) : []
  const check = useCheckSummary(rows)
  const create = useCreateRows({ onCreated: onDone })

  return (
    <form
      id={formId}
      className="contents"
      onSubmit={form.handleSubmit((submitted) => create.create(montageRows(entry, submitted)))}
      onKeyDown={submitOnCtrlEnter}
    >
      <DialogLayout
        title="В план"
        description={`Под монтаж из ${entry.id}`}
        left={left}
        check={check.summary}
        summary={
          rows.length > 0
            ? `Строка ждёт монтаж · ${filesWord(files.length)} ${entry.id} · ${pagesWord(values.accounts.length)} · ${slotText(values.date, values.time)}`
            : 'Отметьте файлы и страницу'
        }
        submit={
          <Button type="submit" form={formId} disabled={rows.length === 0} pending={create.pending}>
            <CalendarPlusIcon />
            Поставить под монтаж
          </Button>
        }
      >
        <Field label="Что выйдет">
          {(labelId) => (
            <Controller
              control={form.control}
              name="expected"
              render={({ field }) => (
                <ChoiceChips
                  labelledBy={labelId}
                  value={field.value}
                  onChange={field.onChange}
                  choices={EXPECTED.map((option) => ({
                    value: option,
                    label: EXPECTED_LABEL[option],
                  }))}
                />
              )}
            />
          )}
        </Field>
        <Field label="Файлы съёмки">
          {() => (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {videos.map((file) => (
                <li key={file.key} className="flex items-center gap-2">
                  <Checkbox
                    id={`${formId}-${file.key}`}
                    checked={files.includes(file.key)}
                    onCheckedChange={(on) =>
                      form.setValue(
                        'files',
                        on === true
                          ? [...files, file.key]
                          : files.filter((key) => key !== file.key),
                      )
                    }
                  />
                  <Label htmlFor={`${formId}-${file.key}`} className="min-w-0 font-mono text-sm">
                    <span className="truncate">{file.file_name}</span>
                    {file.duration_s !== null ? (
                      <span className="text-ink-3">{formatDuration(file.duration_s)}</span>
                    ) : null}
                  </Label>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Страница">
          {(labelId) => (
            <Controller
              control={form.control}
              name="accounts"
              render={({ field }) => (
                <PagePills
                  accounts={data.model.accounts}
                  value={field.value}
                  onChange={field.onChange}
                  disabledReason={(account) =>
                    pageBlockReason([entry], account, EXPECTED_SURFACE[values.expected])
                  }
                  labelledBy={labelId}
                />
              )}
            />
          )}
        </Field>
        <Field label="День">
          {() => (
            <Controller
              control={form.control}
              name="date"
              render={({ field }) => (
                <DayPicker
                  value={field.value}
                  onChange={field.onChange}
                  today={data.today}
                  marked={gapDays(data.gaps, values.accounts, EXPECTED_SURFACE[values.expected])}
                  label="День"
                />
              )}
            />
          )}
        </Field>
      </DialogLayout>
    </form>
  )
}
