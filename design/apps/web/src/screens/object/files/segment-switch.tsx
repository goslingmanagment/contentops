import { ToggleGroup, ToggleGroupItem } from '@contentops/ui/components/toggle-group'

export interface Segment<Value extends string> {
  value: Value
  label: string
}

interface SegmentSwitchProps<Value extends string> {
  segments: readonly Segment<Value>[]
  value: Value
  onChange: (value: Value) => void
  label: string
}

/** Переключатель вида раздела файлов: «Все кадры · 46 / Отобранные · 21» (DESIGN §4.5). */
export function SegmentSwitch<Value extends string>({
  segments,
  value,
  onChange,
  label,
}: SegmentSwitchProps<Value>) {
  return (
    <ToggleGroup
      type="single"
      variant="segment"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const chosen = segments.find((segment) => segment.value === next)
        if (chosen) {
          onChange(chosen.value)
        }
      }}
    >
      {segments.map((segment) => (
        <ToggleGroupItem key={segment.value} value={segment.value} className="px-3 text-sm">
          {segment.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
