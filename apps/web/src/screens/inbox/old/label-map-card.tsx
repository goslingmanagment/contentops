import {
  type Account,
  formatNumber,
  type LabelMapping,
  type LabelTarget,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { Thumb } from '@contentops/ui/components/thumb'
import { useMemo, useState } from 'react'

const POST_NUMBER = 'post'

interface TargetOption {
  value: string
  label: string
  target: LabelTarget
}

/** Страницы модели по одной, все Fansly вместе и «номер поста дня» (DESIGN §4.9). */
function targetOptions(accounts: readonly Account[]): TargetOption[] {
  const single = accounts.map((account) => ({
    value: account.code,
    label: account.label,
    target: { kind: 'accounts' as const, accounts: [account.code] },
  }))
  const fansly = accounts.filter((account) => account.platform === 'fansly')
  const together =
    fansly.length > 1
      ? [
          {
            value: fansly.map((account) => account.code).join(','),
            label: fansly.map((account) => account.label).join(', '),
            target: { kind: 'accounts' as const, accounts: fansly.map((account) => account.code) },
          },
        ]
      : []
  return [
    ...single,
    ...together,
    { value: POST_NUMBER, label: 'номер поста дня', target: { kind: 'post_number' } },
  ]
}

function optionValueOf(target: LabelTarget | null): string | undefined {
  if (!target) {
    return undefined
  }
  return target.kind === 'post_number' ? POST_NUMBER : target.accounts.join(',')
}

interface LabelMapCardProps {
  labels: readonly LabelMapping[]
  accounts: readonly Account[]
  saving: boolean
  onSave: (labels: readonly { label: string; target: LabelTarget | null }[]) => void
}

/**
 * Разовая карточка «Метки старых имён → страницы» (DESIGN §4.9): метка, примеры файлов,
 * выбор страницы, «Сохранить». Видна, пока хоть одна метка без страницы; до сохранения
 * метки из имён ждут, размещений нет. Строками стоят только метки без страницы, уже
 * сопоставленные свёрнуты в одну строку «ещё 5 меток сопоставлены · изменить» — карточка
 * не занимает первый экран, и «Спорное» видно сразу.
 */
export function LabelMapCard({ labels, accounts, saving, onSave }: LabelMapCardProps) {
  const options = useMemo(() => targetOptions(accounts), [accounts])
  const [chosen, setChosen] = useState<Record<string, string | undefined>>(() =>
    Object.fromEntries(labels.map((label) => [label.label, optionValueOf(label.target)])),
  )
  const [showMapped, setShowMapped] = useState(false)
  const missing = labels.filter((label) => !chosen[label.label]).length
  const mapped = labels.filter((label) => label.target !== null)
  const shown = showMapped ? labels : labels.filter((label) => label.target === null)
  const save = () =>
    onSave(
      labels.map((label) => ({
        label: label.label,
        target: options.find((option) => option.value === chosen[label.label])?.target ?? null,
      })),
    )

  return (
    <section className="flex max-w-3xl flex-col gap-3 rounded-2xl border border-border p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg">Метки старых имён → страницы</h2>
        <span className="text-ink-3 text-sm">
          {missing > 0
            ? `${formatNumber(missing)} ${plural(missing, ['метка', 'метки', 'меток'])} без страницы`
            : 'все метки со страницей'}
        </span>
      </header>
      <ul className="flex flex-col">
        {shown.map((label) => (
          <li key={label.label} className="grid h-13 grid-cols-[6rem_1fr_16rem] items-center gap-4">
            <span className="font-mono text-sm">{label.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              {label.examples.slice(0, 3).map((example) => (
                <Thumb
                  key={example.name}
                  seed={example.thumb.key}
                  showCaptions={false}
                  className="w-7.5 shrink-0 rounded-md"
                />
              ))}
              <span className="truncate font-mono text-ink-3 text-xs">
                {label.examples.map((example) => example.name).join(' · ')}
              </span>
            </span>
            <Select
              value={chosen[label.label]}
              onValueChange={(value) =>
                setChosen((current) => ({ ...current, [label.label]: value }))
              }
            >
              <SelectTrigger aria-label={`Страница для метки ${label.label}`} className="w-full">
                <SelectValue placeholder="Страница" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-4">
        <Button variant="outline" pending={saving} onClick={save}>
          Сохранить
        </Button>
        {mapped.length > 0 && !showMapped ? (
          <span className="text-ink-3 text-sm">
            {`ещё ${formatNumber(mapped.length)} ${plural(mapped.length, ['метка сопоставлена', 'метки сопоставлены', 'меток сопоставлены'])} · `}
            <Button
              variant="link"
              size="inline"
              className="text-sm"
              onClick={() => setShowMapped(true)}
            >
              изменить
            </Button>
          </span>
        ) : null}
      </div>
    </section>
  )
}
