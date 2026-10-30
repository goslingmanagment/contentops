import { addDays, mskDate, mskInstant } from '@contentops/contracts/clock'
import type { Evidence } from '@contentops/contracts/domain/placement'
import { formatDuration, formatStamp } from '@contentops/contracts/format'
import type { EvidenceRecord, RowRecord } from '../../plan/records'
import type { HubFacts } from './facts'
import { albumFits, rowAlbum } from './match'

/**
 * Stored Hub evidence in the words of the placement function (SPEC §7, DESIGN §5.2): an exact
 * file by name or in an album, a candidate with its post, «совпало k из n», a length that
 * differs, «стена или фуп?», a confirmed pair seen again, a history match; and what follows from
 * the vault walks without a stored row: «в альбоме нет файла».
 */

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10)

export function hubEvidence(row: EvidenceRecord, _hub: HubFacts): Evidence[] {
  const p = row.payload
  const base = { id: row.id, recorded_at: row.recorded_at }
  const at = str(p.published_at) ?? row.event_at ?? row.recorded_at
  if (row.kind === 'reused_pair') {
    const confirmed = str(p.confirmed_at) ?? row.recorded_at
    return [
      {
        ...base,
        kind: 'manual_earlier',
        confirmed_on: mskDate(confirmed),
        ...(p.by_agent === true ? { by_agent: true } : {}),
      },
    ]
  }
  if (row.strength === 'exact') {
    if (p.via === 'publication') {
      // A row sent through Hub (5б): the publication names the post or the album.
      const album = typeof p.media_ref === 'string' || row.external_ref?.startsWith('alb')
      return [
        {
          ...base,
          kind: 'hub_exact',
          post_at: at,
          match: album ? 'album' : 'file',
          file_name: null,
          duration: null,
        },
      ]
    }
    if (p.match === 'album') {
      if (p.reupload === true && str(p.created_at_platform)) {
        return [
          {
            ...base,
            kind: 'vault_reupload',
            file_on: mskDate(str(p.created_at_platform) as string),
          },
        ]
      }
      return [
        {
          ...base,
          kind: 'hub_exact',
          post_at: at,
          match: 'album',
          file_name: str(p.file_name),
          duration: null,
        },
      ]
    }
    const ours = seconds(num(p.ours_ms))
    const theirs = seconds(num(p.duration_ms))
    return [
      {
        ...base,
        kind: 'hub_exact',
        post_at: at,
        match: 'file_name',
        file_name: str(p.file_name),
        duration: ours !== null && theirs !== null ? { ours_s: ours, theirs_s: theirs } : null,
      },
    ]
  }
  switch (p.kind) {
    case 'history':
      return [{ ...base, kind: 'hub_history', post_at: at }]
    case 'surface':
      return [{ ...base, kind: 'hub_surface_unknown', post_at: at }]
    case 'stale':
      return [
        {
          ...base,
          kind: 'vault_stale',
          album: str(p.album_title) ?? '',
          file_on: mskDate(str(p.created_at_platform) ?? at),
          row_on: mskDate(str(p.row_created_at) ?? row.recorded_at),
        },
      ]
    case 'mismatch': {
      const duration = p.duration as { ours?: number; theirs?: number } | null
      return [
        {
          ...base,
          kind: 'hub_mismatch',
          post_at: at,
          field: 'duration',
          ours: formatDuration((duration?.ours ?? 0) / 1000),
          theirs: formatDuration((duration?.theirs ?? 0) / 1000),
        },
      ]
    }
    case 'partial': {
      const matched = num(p.matched) ?? 0
      const total = num(p.row_files) ?? matched
      const postFiles = num(p.post_files) ?? total
      return [
        {
          ...base,
          kind: 'hub_partial',
          matched,
          total: Math.max(total, 1),
          missing:
            postFiles !== total
              ? `в посте ${postFiles} из ${total}`
              : `по имени не совпало ${total - matched}`,
        },
      ]
    }
    case 'vault':
      return [
        {
          ...base,
          kind: 'hub_candidate',
          post_at: at,
          offset_min: 0,
          summary: `в альбоме «${str(p.album_title) ?? ''}» по длительности и размерам`,
        },
      ]
    default: {
      const rowFiles = num(p.row_files)
      const postFiles = num(p.post_files)
      const count =
        rowFiles !== null && postFiles !== null && rowFiles !== postFiles
          ? ` · в посте ${postFiles} файлов из ${rowFiles}`
          : ''
      return [
        {
          ...base,
          kind: 'hub_candidate',
          post_at: at,
          offset_min: num(p.dt_minutes) ?? 0,
          summary: `${str(p.post_summary) ?? 'пост'}${count}`,
        },
      ]
    }
  }
}

/** The moment after which a vault row is late: its slot, or the end of its day. */
function deadlineOf(row: Pick<RowRecord, 'slot_date' | 'slot_time'>): string {
  return row.slot_time
    ? mskInstant(row.slot_date, row.slot_time)
    : mskInstant(addDays(row.slot_date, 1))
}

const ANSWERED = new Set<Evidence['kind']>([
  'hub_exact',
  'hub_candidate',
  'hub_partial',
  'vault_stale',
  'vault_reupload',
  'manual_confirm',
  'manual_earlier',
])

/**
 * What the vault walks say about a vault row without a stored answer (SPEC §7): the row's
 * album walked in full after its deadline and nothing found — «в альбоме нет файла»; otherwise
 * the reason why Hub cannot say yet — when it last walked the album.
 */
export function rowHubEvidence(
  state: { hub: HubFacts; now: string },
  row: RowRecord,
  own: readonly Evidence[],
): { evidence: Evidence[]; reason: string | null } {
  if (
    row.surface !== 'vault' ||
    row.platform !== 'fansly' ||
    !row.item_type ||
    row.item_number === null
  ) {
    return { evidence: [], reason: null }
  }
  const page = state.hub.pages.get(row.account)
  if (!page) return { evidence: [], reason: null }
  const target = {
    albumName: row.album_name,
    itemPublicId: `${row.item_type}-${String(row.item_number).padStart(row.item_type === 'FYP' || row.item_type === 'RAW' ? 4 : 3, '0')}`,
    itemTitle: row.item_title,
  }
  const albums = page.albums.filter((album) => albumFits(album.title, target))
  const walked = albums
    .filter((album) => album.walkedAt !== null)
    .sort((a, b) => (b.walkedAt as string).localeCompare(a.walkedAt as string))[0]
  const name = rowAlbum(target)
  const reason = walked
    ? `Hub обходил альбом «${walked.title}» ${formatStamp(walked.walkedAt as string, state.now)}`
    : albums[0]
      ? `Hub ещё не обходил альбом «${albums[0].title}» целиком`
      : `Hub не видел альбома «${name}»`
  if (own.some((entry) => ANSWERED.has(entry.kind))) return { evidence: [], reason }
  const deadline = deadlineOf(row)
  if (
    walked &&
    Date.parse(walked.walkedAt as string) > Date.parse(deadline) &&
    Date.parse(state.now) > Date.parse(deadline)
  ) {
    return {
      evidence: [
        {
          id: `walk:${row.id}`,
          recorded_at: walked.walkedAt as string,
          kind: 'vault_missing',
          album: walked.title,
          walked_on: mskDate(walked.walkedAt as string),
        },
      ],
      reason,
    }
  }
  return { evidence: [], reason }
}
