import { formatDate, type LocalDate, mskDate } from '@contentops/contracts'

/**
 * The line under a matter of «Ждут вас»: since when it waits. The owner (who has Hub) also reads where it came from;
 * a content manager never sees Hub, so the source word is not hers (review round 2, P3-6).
 */
export function matterNote(openedAt: string, today: LocalDate, hasHub: boolean): string {
  const since = `ждёт с ${formatDate(mskDate(openedAt), today)}`
  return hasHub ? `Hub · ${since}` : since
}
