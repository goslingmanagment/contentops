import { type FanName, FanNameSchema } from '@contentops/contracts'
import {
  FilterChipsRow,
  type FilterOption,
  FilterSelectChip,
  FilterToggleChip,
} from '@contentops/ui/components/filter-chips'
import { type DeliveredWithin, DeliveredWithinSchema } from '../search'
import type { ToPpvFilters } from './to-ppv-rows'

const NAME_OPTIONS: readonly FilterOption[] = [
  { value: 'no', label: 'нет' },
  { value: 'yes', label: 'есть' },
  { value: 'unknown', label: 'не знаю' },
] satisfies readonly { value: FanName; label: string }[]

const DELIVERED_OPTIONS: readonly FilterOption[] = [
  { value: 'week', label: 'за неделю' },
  { value: 'month', label: 'за месяц' },
  { value: 'older', label: 'раньше' },
] satisfies readonly { value: DeliveredWithin; label: string }[]

interface ToPpvChipsProps {
  filters: ToPpvFilters
  onChange: (next: ToPpvFilters) => void
}

const NO_FILTERS: ToPpvFilters = { todo: false, name: undefined, delivered: undefined }

/** Чипы «Не сделано», «Имя ▾», «Сдано ▾» (DESIGN §4.2); ряд стоит всегда. */
export function ToPpvChips({ filters, onChange }: ToPpvChipsProps) {
  const active = filters.todo || filters.name !== undefined || filters.delivered !== undefined
  return (
    <FilterChipsRow canReset={active} onReset={() => onChange(NO_FILTERS)}>
      <FilterToggleChip
        label="Не сделано"
        pressed={filters.todo}
        onPressedChange={(todo) => onChange({ ...filters, todo })}
      />
      <FilterSelectChip
        label="Имя"
        options={NAME_OPTIONS}
        selected={filters.name ? [filters.name] : []}
        onSelectedChange={([value]) =>
          onChange({ ...filters, name: FanNameSchema.safeParse(value).data })
        }
      />
      <FilterSelectChip
        label="Сдано"
        options={DELIVERED_OPTIONS}
        selected={filters.delivered ? [filters.delivered] : []}
        onSelectedChange={([value]) =>
          onChange({ ...filters, delivered: DeliveredWithinSchema.safeParse(value).data })
        }
      />
    </FilterChipsRow>
  )
}
