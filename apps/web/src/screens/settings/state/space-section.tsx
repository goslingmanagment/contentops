import { type Disk, formatBytes, type SystemState } from '@contentops/contracts'
import { Progress } from '@contentops/ui/components/progress'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { cn } from '@contentops/ui/lib/utils'
import { useClock } from '@/data/api-session'
import { backupWords } from './backup-words'

interface SpaceSectionProps {
  disks: readonly Disk[]
  backup: SystemState['backup']
}

/** Полоса диска: синяя, янтарная ниже порога предупреждения, красная ниже остановки забора. */
function toneOf(free: number, disk: Disk): string {
  if (free <= disk.stop_below_bytes) {
    return '[&>[data-slot=progress-indicator]]:bg-destructive'
  }
  if (free <= disk.warn_below_bytes) {
    return '[&>[data-slot=progress-indicator]]:bg-attention'
  }
  return ''
}

function DiskBar({ disk }: { disk: Disk }) {
  const free = disk.free_bytes
  const total = disk.total_bytes
  if (free === null || total === null) {
    // Хост давно не присылал место: число не выдумывается (§12.2).
    return <span className="text-muted-foreground">нет данных</span>
  }
  const used = 1 - free / total
  return (
    <span className="flex w-72 flex-col gap-1.5">
      <span className="text-right text-sm tabular-nums">
        свободно {formatBytes(free)} из {formatBytes(total)}
      </span>
      <Progress
        aria-label={`Занято на ${disk.name}`}
        value={used * 100}
        className={cn('h-1.5', toneOf(free, disk))}
      />
    </span>
  )
}

/** Место C: и E: с порогами, бэкап — отдельной строкой (§4.19). */
export function SpaceSection({ disks, backup }: SpaceSectionProps) {
  const now = useClock().now()
  const words = backupWords(backup, now)
  return (
    <SettingsSection title="Место и бэкап">
      {disks.map((disk) => (
        <SettingsRow
          key={disk.name}
          label={disk.name}
          detail={`предупреждение ${formatBytes(disk.warn_below_bytes)} · остановка забора ${formatBytes(disk.stop_below_bytes)}`}
        >
          <DiskBar disk={disk} />
        </SettingsRow>
      ))}
      <SettingsRow label="Бэкап" detail={words.detail}>
        <span className="text-muted-foreground">{words.value}</span>
      </SettingsRow>
    </SettingsSection>
  )
}
