import { formatNumber, type OriginalsLine } from '@contentops/contracts'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { StatusSign } from '@contentops/ui/components/status-sign'

const GB = 1_000_000_000

/** «надёжны 17 196 из 29 384 · ждут проверки 6 022 · на ПК освобождено 241 ГБ · копий не найдено 3». */
export function originalsText(line: OriginalsLine): string {
  return [
    `надёжны ${formatNumber(line.reliable)} из ${formatNumber(line.originals)}`,
    `ждут проверки ${formatNumber(line.waiting)}`,
    `на ПК освобождено ${formatNumber(Math.round(line.freed_bytes / GB))} ГБ`,
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
