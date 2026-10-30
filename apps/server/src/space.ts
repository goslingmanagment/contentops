import { readFile } from 'node:fs/promises'
import type { IntegrationLine } from '@contentops/contracts/domain/integrations'
import type { Disk, SpaceCard } from '@contentops/contracts/domain/system'
import { formatBytes } from '@contentops/contracts/format'
import { z } from 'zod'

/**
 * Free space of the host disks (SPEC §12.2). On the pilot the VM disks are growing VHDX
 * files, so space inside the VM lies: a Windows task writes `space.json` every 5 minutes
 * into a read-only share (`ops/winpc/ContentOps-Space.ps1`), the web container reads it.
 */

const HostSpaceSchema = z.object({
  measured_at: z.iso.datetime({ offset: true }),
  disks: z.array(
    z.object({
      name: z.string().min(1),
      free_bytes: z.int().nonnegative(),
      total_bytes: z.int().positive(),
    }),
  ),
})
export type HostSpace = z.infer<typeof HostSpaceSchema>

/** The host writes every 5 min; three missed reports — «нет данных». */
export const SPACE_STALE_MS = 15 * 60_000

const GB = 1_000_000_000

export interface SpaceOptions {
  /** `HOST_SPACE_FILE`; without it there is nothing to show. */
  file: string | undefined
  warnGb: number
  stopGb: number
}

/** The last report, or `null` when the file is missing or broken. */
export async function readHostSpace(file: string | undefined): Promise<HostSpace | null> {
  if (!file) return null
  try {
    const text = (await readFile(file, 'utf8')).replace(/^﻿/, '')
    const parsed = HostSpaceSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function isFresh(space: HostSpace, now: Date): boolean {
  const age = now.getTime() - Date.parse(space.measured_at)
  // A clock a little ahead on the host is not «stale».
  return age <= SPACE_STALE_MS && age >= -SPACE_STALE_MS
}

/** Disks of «Настройки › Состояние»: names from the last report, numbers only while fresh. */
export function diskViews(space: HostSpace | null, options: SpaceOptions, now: Date): Disk[] {
  const thresholds = {
    warn_below_bytes: Math.round(options.warnGb * GB),
    stop_below_bytes: Math.round(options.stopGb * GB),
  }
  if (!space) {
    return [
      { name: 'Место', free_bytes: null, total_bytes: null, measured_at: null, ...thresholds },
    ]
  }
  const fresh = isFresh(space, now)
  return space.disks.map((disk) => ({
    name: disk.name,
    free_bytes: fresh ? disk.free_bytes : null,
    total_bytes: fresh ? disk.total_bytes : null,
    measured_at: space.measured_at,
    ...thresholds,
  }))
}

function wholeGb(bytes: number): string {
  return `${Math.round(bytes / GB)} ГБ`
}

function spaceLine(disk: Disk, text: string): IntegrationLine {
  return {
    integration_id: `space:${disk.name}`,
    state: 'down',
    icon: 'dot',
    tone: 'attention',
    text,
    owner_action: null,
  }
}

/**
 * Card at the bottom of the left column (DESIGN §2.2): the first disk (C: on the pilot) and
 * lines only when something is wrong — «Мало места: 180 ГБ», «Забор остановлен: свободно
 * 95 ГБ» (SPEC §12.2; thresholds of the pilot 200 / 100 GB).
 */
export function spaceCard(disks: readonly Disk[]): SpaceCard {
  const [first] = disks
  const alerts = disks.flatMap((disk, index) => {
    if (disk.free_bytes === null) return []
    const prefix = index === 0 ? '' : `${disk.name} `
    if (disk.free_bytes <= disk.stop_below_bytes) {
      return [spaceLine(disk, `${prefix}Забор остановлен: свободно ${wholeGb(disk.free_bytes)}`)]
    }
    if (disk.free_bytes <= disk.warn_below_bytes) {
      return [spaceLine(disk, `${prefix}Мало места: ${wholeGb(disk.free_bytes)}`)]
    }
    return []
  })
  if (!first || first.free_bytes === null || first.total_bytes === null) {
    return { label: `${first?.name ?? 'Место'} нет данных`, used_fraction: 0, alerts }
  }
  return {
    label: `${first.name} свободно ${formatBytes(first.free_bytes)}`,
    used_fraction: Math.min(1, Math.max(0, 1 - first.free_bytes / first.total_bytes)),
    alerts,
  }
}
