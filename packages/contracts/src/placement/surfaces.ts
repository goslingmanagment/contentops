import type { Platform } from '../domain/model'
import type { HubCoverage, PlacementFacts, SurfaceKind } from '../domain/placement'
import { coverageReason } from './texts'

/** Which surfaces Hub checks by itself: posts on Fansly and OnlyFans, vault only on Fansly. */
const AUTO_CHECKED_SURFACES: Record<Platform, readonly SurfaceKind[]> = {
  fansly: ['wall', 'fyp', 'vault'],
  onlyfans: ['wall'],
}

export function isCheckableSurface(platform: Platform, surface: SurfaceKind): boolean {
  return AUTO_CHECKED_SURFACES[platform].includes(surface)
}

/** Hub checks this surface of this page by itself. */
export function isAutoChecked(
  platform: Platform,
  surface: SurfaceKind,
  hubState: HubCoverage['state'],
): boolean {
  if (hubState === 'off' || hubState === 'unset') return false
  return isCheckableSurface(platform, surface)
}

/**
 * Which button a plan row gets: plain «Отметить» or «Отметить и подтвердить»
 * where Hub does not check (DESIGN §4.11, §10.4).
 */
export function markButtonKind(
  platform: Platform,
  surface: SurfaceKind,
  hubState: HubCoverage['state'],
): 'mark' | 'mark_confirm' {
  if (isAutoChecked(platform, surface, hubState)) return 'mark'
  if (platform === 'fansly' && (surface === 'story' || surface === 'dm')) return 'mark'
  return 'mark_confirm'
}

/** «Hub видел на стене 11:02». */
export const SURFACE_LOCATIVE: Record<SurfaceKind, string> = {
  wall: 'на стене',
  fyp: 'в ленте FYP',
  vault: 'в vault',
  story: 'в сториз',
  dm: 'в рассылке',
}

/** «Hub не проверяет рассылку OF VIP». */
const SURFACE_ACCUSATIVE: Record<SurfaceKind, string> = {
  wall: 'стену',
  fyp: 'FYP',
  vault: 'vault',
  story: 'сториз',
  dm: 'рассылку',
}

/** Why Hub says nothing about a planned placement yet. */
export function hubSilenceReason(facts: PlacementFacts): string {
  const { account, surface, hub } = facts
  if (hub.state === 'off' || hub.state === 'unset') return coverageReason(hub, account.label)
  if (!isCheckableSurface(account.platform, surface)) {
    return `Hub не проверяет ${SURFACE_ACCUSATIVE[surface]} ${account.label}`
  }
  // Hub видит не все посты — так и говорим, а не «ещё не видел» (строка и «почему» — одно).
  return hub.state === 'down' || hub.state === 'partial'
    ? coverageReason(hub, account.label)
    : 'Hub ещё не видел'
}
