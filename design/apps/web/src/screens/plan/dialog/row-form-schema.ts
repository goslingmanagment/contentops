import {
  AccountCodeSchema,
  type CatalogEntry,
  formatNumber,
  LocalDateSchema,
  LocalTimeSchema,
  type NewPlanRow,
  type PersonRef,
  plural,
  SURFACE_LABEL,
  SurfaceKindSchema,
  UniqLevelSchema,
} from '@contentops/contracts'
import { z } from 'zod'
import { slotText } from '../shared/plan-text'
import type { VersionPick } from './fyp-versions'

/** Поля вкладки «Строка» окна «В план» (DESIGN §4.13) на схемах контракта. */
export const RowFormSchema = z.object({
  accounts: z.array(AccountCodeSchema).min(1, 'Выберите страницу'),
  surface: SurfaceKindSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema.nullable(),
  /** `null` — кто обычно выкладывает на странице. */
  assignee: z.string().nullable(),
  note: z.string().max(500),
  level: UniqLevelSchema,
  /** «Залить заново (новый файл)» у vault. */
  reupload: z.boolean(),
})
export type RowForm = z.infer<typeof RowFormSchema>

interface BuildRowsInput {
  entry: CatalogEntry
  form: RowForm
  picks: readonly VersionPick[]
  /** «Выложено вне плана»: строка создаётся сразу отмеченной. */
  outside: boolean
  /**
   * Время каждой страницы: пока время не трогали руками, у каждой страницы — время её
   * нормы для этого места (§4.13); иначе — выбранное.
   */
  timeOf?: (account: string) => string | null
}

/** По строке на страницу; у фупа — своя версия на каждой. */
export function buildRows({ entry, form, picks, outside, timeOf }: BuildRowsInput): NewPlanRow[] {
  return form.accounts.map((account) => {
    const pick = picks.find((candidate) => candidate.account === account)
    return {
      item_id: entry.id,
      account,
      surface: form.surface,
      date: form.date,
      time: timeOf ? timeOf(account) : form.time,
      fyp_version: form.surface === 'fyp' && pick ? { no: pick.no, level: form.level } : null,
      assignee: form.assignee,
      note: form.note.trim() || null,
      requires_new_upload: form.surface === 'vault' && form.reupload,
      awaiting_montage: null,
      marked: outside ? 'posted' : null,
    }
  })
}

export function pagesWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['страница', 'страницы', 'страниц'])}`
}

/** «PPV-076 · 3 страницы · стена · чт 24, 20:00 · Диана». */
export function rowsSummary(
  what: string,
  form: Pick<RowForm, 'accounts' | 'surface' | 'date' | 'time'>,
  assignee: PersonRef | undefined,
): string {
  return [
    what,
    pagesWord(form.accounts.length),
    SURFACE_LABEL[form.surface],
    slotText(form.date, form.time),
    assignee?.name,
  ]
    .filter(Boolean)
    .join(' · ')
}
