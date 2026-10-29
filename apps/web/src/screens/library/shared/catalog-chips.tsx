import {
  type Account,
  type CatalogEntry,
  FanNameSchema,
  MarkupStateSchema,
  RAW_PURPOSE_LABEL,
  RawPurposeSchema,
  type Tag,
} from '@contentops/contracts'
import {
  type FilterOption,
  FilterSelectChip,
  FilterToggleChip,
} from '@contentops/ui/components/filter-chips'
import { Fragment, type ReactNode, useMemo } from 'react'
import { type CatalogFilters, PeriodSchema } from '../search'
import { whereConditions } from './catalog-filters'
import { WhereChip } from './where-chip'

/**
 * Чипы фильтров каталога (DESIGN §4.2): общие («Где залито ▾», «Теги ▾», «Разметка ▾»,
 * «Дата ▾», «Второй человек») и по типу. Экран перечисляет, какие чипы ему нужны, чип сам
 * знает свой параметр адреса.
 */
export type CatalogChipKey =
  | 'where'
  | 'tags'
  | 'markup'
  | 'period'
  | 'second'
  | 'kind'
  | 'noteaser'
  | 'nophotos'
  | 'nover'
  | 'steady'
  | 'name'
  | 'photo'
  | 'unpicked'
  | 'unassigned'
  | 'use'
  | 'purpose'

export interface ChipProps {
  filters: CatalogFilters
  onChange: (patch: Partial<CatalogFilters>) => void
  accounts: readonly Account[]
  tagOptions: readonly FilterOption[]
}

const MARKUP_OPTIONS: readonly FilterOption[] = [
  { value: 'draft', label: 'черновик' },
  { value: 'partial', label: 'частично' },
  { value: 'confirmed', label: 'подтверждена' },
]

const PERIOD_OPTIONS: readonly FilterOption[] = [
  { value: 'week', label: 'за неделю' },
  { value: 'month', label: 'за месяц' },
  { value: 'quarter', label: 'за 3 месяца' },
  { value: 'year', label: 'за год' },
]

const NAME_OPTIONS: readonly FilterOption[] = [
  { value: 'yes', label: 'есть' },
  { value: 'no', label: 'нет' },
  { value: 'unknown', label: 'не знаю' },
]

const PURPOSE_OPTIONS: readonly FilterOption[] = RawPurposeSchema.options.map((purpose) => ({
  value: purpose,
  label: RAW_PURPOSE_LABEL[purpose],
}))

function single<T>(value: T | undefined): string[] {
  return value === undefined ? [] : [String(value)]
}

/** Переключатель, который включает значение, а повторное нажатие выключает. */
function choice<T extends string>(current: T | undefined, value: T, pressed: boolean) {
  if (pressed) {
    return value
  }
  return current === value ? undefined : current
}

/** Чипы-переключатели «да / всё равно»: у каждого свой флаг в адресе. */
type FlagKey = 'second' | 'noteaser' | 'nophotos' | 'steady' | 'photo' | 'unpicked' | 'unassigned'

const FLAG_LABEL: Record<FlagKey, string> = {
  second: 'Второй человек',
  noteaser: 'Без тизера',
  nophotos: 'Без фото',
  steady: 'SteadyContent',
  photo: 'Фото-кастомы',
  unpicked: 'Не отобран',
  unassigned: 'Без назначения',
}

function flagChip(key: FlagKey) {
  return ({ filters, onChange }: ChipProps) => (
    <FilterToggleChip
      label={FLAG_LABEL[key]}
      pressed={filters[key] === true}
      onPressedChange={(pressed) => {
        const patch: Partial<CatalogFilters> = {}
        patch[key] = pressed || undefined
        onChange(patch)
      }}
    />
  )
}

/** Пара взаимоисключающих чипов одного параметра: «Бандл» / «В личку», «В ленту» / «В чаты». */
function pairChips<Value extends string>(
  labels: Record<Value, string>,
  read: (filters: CatalogFilters) => Value | undefined,
  write: (value: Value | undefined) => Partial<CatalogFilters>,
) {
  const values = Object.keys(labels) as Value[]
  return ({ filters, onChange }: ChipProps) =>
    values.map((value) => (
      <FilterToggleChip
        key={value}
        label={labels[value]}
        pressed={read(filters) === value}
        onPressedChange={(pressed) => onChange(write(choice(read(filters), value, pressed)))}
      />
    ))
}

const CHIPS: Record<CatalogChipKey, (props: ChipProps) => ReactNode> = {
  where: ({ filters, onChange, accounts }) => (
    <WhereChip
      key="where"
      accounts={accounts}
      conditions={whereConditions(filters)}
      onChange={(next) => onChange({ where: next.length > 0 ? next : undefined })}
    />
  ),
  tags: ({ filters, onChange, tagOptions }) => (
    <FilterSelectChip
      key="tags"
      label="Теги"
      multiple
      searchPlaceholder="Найти тег"
      options={tagOptions}
      selected={filters.tag ?? []}
      onSelectedChange={(next) => onChange({ tag: next.length > 0 ? next : undefined })}
    />
  ),
  markup: ({ filters, onChange }) => (
    <FilterSelectChip
      key="markup"
      label="Разметка"
      options={MARKUP_OPTIONS}
      selected={single(filters.markup)}
      onSelectedChange={([next]) => onChange({ markup: MarkupStateSchema.safeParse(next).data })}
    />
  ),
  period: ({ filters, onChange }) => (
    <FilterSelectChip
      key="period"
      label="Дата"
      options={PERIOD_OPTIONS}
      selected={single(filters.period)}
      activeLabel={(summary) => `Пришло ${summary}`}
      onSelectedChange={([next]) => onChange({ period: PeriodSchema.safeParse(next).data })}
    />
  ),
  second: flagChip('second'),
  kind: pairChips(
    { bundle: 'Бандл', dm: 'В личку' },
    (filters) => filters.kind,
    (kind) => ({ kind }),
  ),
  noteaser: flagChip('noteaser'),
  nophotos: flagChip('nophotos'),
  nover: ({ filters, onChange, accounts }) => (
    <FilterSelectChip
      key="nover"
      label="Версий нет на"
      options={accounts
        .filter((account) => account.platform === 'fansly')
        .map((account) => ({ value: account.code, label: account.label }))}
      selected={single(filters.nover)}
      activeLabel={(summary) => `Версий нет на ${summary}`}
      onSelectedChange={([next]) => onChange({ nover: next })}
    />
  ),
  steady: flagChip('steady'),
  name: ({ filters, onChange }) => (
    <FilterSelectChip
      key="name"
      label="Имя"
      options={NAME_OPTIONS}
      selected={single(filters.name)}
      activeLabel={(summary) => (summary === 'не знаю' ? 'Имя: не знаю' : `Имя ${summary}`)}
      onSelectedChange={([next]) => onChange({ name: FanNameSchema.safeParse(next).data })}
    />
  ),
  photo: flagChip('photo'),
  unpicked: flagChip('unpicked'),
  unassigned: flagChip('unassigned'),
  use: pairChips(
    { feed: 'В ленту', chats: 'В чаты' },
    (filters) => filters.use,
    (use) => ({ use }),
  ),
  purpose: ({ filters, onChange }) => (
    <FilterSelectChip
      key="purpose"
      label="Назначение"
      options={PURPOSE_OPTIONS}
      selected={single(filters.purpose)}
      activeLabel={(summary) => `Назначение: ${summary}`}
      onSelectedChange={([next]) => onChange({ purpose: RawPurposeSchema.safeParse(next).data })}
    />
  ),
}

/** Теги, которые есть у этих объектов, самые частые первыми, русскими именами. */
export function useTagOptions(
  entries: readonly CatalogEntry[],
  tags: readonly Tag[] | undefined,
): FilterOption[] {
  return useMemo(() => {
    const uses = new Map<string, number>()
    for (const entry of entries) {
      for (const key of entry.tags) {
        uses.set(key, (uses.get(key) ?? 0) + 1)
      }
    }
    const names = new Map((tags ?? []).map((tag) => [tag.key, tag.ru ?? tag.key]))
    return [...uses.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([key]) => ({ value: key, label: names.get(key) ?? key }))
  }, [entries, tags])
}

export function CatalogChips({
  chips,
  ...props
}: ChipProps & { chips: readonly CatalogChipKey[] }) {
  return chips.map((chip) => <Fragment key={chip}>{CHIPS[chip](props)}</Fragment>)
}
