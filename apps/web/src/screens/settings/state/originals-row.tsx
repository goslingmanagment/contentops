import { formatNumber, type OriginalsLine } from '@contentops/contracts'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { StatusSign } from '@contentops/ui/components/status-sign'

const GB = 1_000_000_000

const gb = (bytes: number) => formatNumber(Math.round(bytes / GB))

/**
 * «надёжны 17 196 из 29 384 · ждут проверки 6 022 · на ПК освобождено 241 ГБ (копия Я.Диска
 * 229 ГБ, ВМ 12 ГБ) · копий не найдено 3».
 */
export function originalsText(line: OriginalsLine): string {
  const vm = line.freed_vm_bytes
  const parts = vm > 0 ? ` (копия Я.Диска ${gb(line.freed_bytes - vm)} ГБ, ВМ ${gb(vm)} ГБ)` : ''
  return [
    `надёжны ${formatNumber(line.reliable)} из ${formatNumber(line.originals)}`,
    `ждут проверки ${formatNumber(line.waiting)}`,
    `на ПК освобождено ${gb(line.freed_bytes)} ГБ${parts}`,
    `копий не найдено ${formatNumber(line.missing)}`,
  ].join(' · ')
}

/**
 * Оригиналы вне ПК (SPEC §9.4): одна строка счёта, под ней ▲ с причинами — пропажи и отказы
 * проверки, мало места в облаке, нет ночной сверки, устарел список ПК.
 */
export function OriginalsRow({ line }: { line: OriginalsLine }) {
  const trouble = line.warnings.length > 0
  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          {trouble ? <StatusSign kind="trouble" label="беда" /> : null}
          Оригиналы
        </span>
      }
      below={
        <div className="-mt-1.5 flex flex-col gap-1 pb-2.5 text-sm">
          <p className="text-muted-foreground tabular-nums">{originalsText(line)}</p>
          {trouble ? <p className="text-destructive">{line.warnings.join(' · ')}</p> : null}
        </div>
      }
    />
  )
}
