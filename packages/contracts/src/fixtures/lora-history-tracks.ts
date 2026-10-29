import { mskInstant } from '../clock'
import type { LocalDate, LocalTime } from '../domain/common'
import { DIANA, NIKITA, type WeekContext } from './lora-plan-week'
import { PERSON } from './people'
import type { BuiltRow, createTrackBuilder } from './plan-builder'
import type { CaseExtras, PlacementTrack } from './world-types'

/**
 * Placements of the detailed objects outside the current plan (DESIGN §9.3, §9.7):
 * PPV-073 history, FYP-0801 on Fansly 1, FYP-0412 views, and the cases of «Сверить»
 * that have no row — the partial album, «стена или фуп?», the post without plan, «Не наше».
 */

const at = (date: LocalDate, time: LocalTime) => mskInstant(date, time)

function extras(patch: Partial<CaseExtras>): CaseExtras {
  return {
    post_summary: '',
    caption: null,
    platform_file_name: null,
    issued_name: null,
    issued_to: null,
    sizes: null,
    hint: null,
    attachments: [],
    ours_duration_s: null,
    theirs_duration_s: null,
    ...patch,
  }
}

export interface HistoryResult {
  rows: BuiltRow[]
  tracks: PlacementTrack[]
}

export function buildDetailedHistory(
  context: WeekContext,
  track: ReturnType<typeof createTrackBuilder>,
): HistoryResult {
  const { evidence, issued, row, titleOf } = context
  const ppv073 = titleOf('PPV-073')
  const album073 = `PPV-073 ${ppv073}`
  const tracks: PlacementTrack[] = [
    track({
      item_id: 'PPV-073',
      account: 'lora-1',
      surface: 'wall',
      evidence: [
        evidence.hubExact(
          at('2026-08-07', '20:01'),
          'file_name',
          issued('PPV-073', 'lora-1', '2026-08-07', '20:00', { version: 1 }),
        ),
      ],
      caption: 'Birthday gift 🎂 full video in DM',
      stats: { views: 1_240, likes: 86, on: '2026-09-22' },
    }),
    track({
      item_id: 'PPV-073',
      account: 'lora-1',
      surface: 'vault',
      album: '07.08 Birthday gift PPV',
      evidence: [evidence.hubExact(at('2026-08-07', '21:10'), 'album')],
    }),
    track({
      item_id: 'PPV-073',
      account: 'lora-2',
      surface: 'vault',
      album: album073,
      evidence: [evidence.hubExact(at('2026-08-08', '21:14'), 'album')],
    }),
    track({
      item_id: 'PPV-073',
      account: 'lora-3',
      surface: 'vault',
      album: album073,
      evidence: [evidence.hubPartial(at('2026-09-21', '09:00'), 22, 23, 'нет фото 17')],
      extras: extras({
        post_summary: 'альбом, 22 файла',
        // Альбом бандла: мастер, тизер и 21 фото (§9.3); не дошло фото 17.
        attachments: Array.from({ length: 23 }, (_, index) => ({
          no: index + 1,
          label: ['мастер', 'тизер'][index] ?? `фото ${index - 1}`,
          ok: index !== 18,
        })),
        issued_name: issued('PPV-073', 'lora-3', '2026-08-09', null, { version: 1 }),
        issued_to: 'Диана · 09.08 12:30',
      }),
    }),
    track({
      item_id: 'PPV-073',
      account: 'lora-vip-of',
      surface: 'dm',
      evidence: [evidence.manualConfirm(NIKITA, at('2026-08-09', '21:10'), 'report')],
    }),
    track({
      item_id: 'PPV-061',
      account: 'lora-2',
      surface: 'wall',
      evidence: [evidence.legacyClaim(at('2026-09-01', '09:00'), 'used2', '2026-07-31')],
    }),
    track({
      item_id: 'FYP-0801',
      account: 'lora-1',
      surface: 'fyp',
      evidence: [
        evidence.hubExact(
          at('2026-08-12', '03:04'),
          'file_name',
          issued('FYP-0801', 'lora-1', '2026-08-12', '03:00'),
          { ours_s: 9, theirs_s: 9 },
        ),
      ],
      stats: { views: 3_410, likes: 204, on: '2026-09-22' },
    }),
    track({
      item_id: 'FYP-0412',
      account: 'lora-1',
      surface: 'fyp',
      evidence: [evidence.hubExact(at('2025-11-16', '03:02'), 'file')],
      stats: { views: 12_480, likes: 910, on: '2026-09-22' },
    }),
    track({
      item_id: 'FYP-0799',
      account: 'lora-1',
      surface: 'fyp',
      evidence: [evidence.hubSurfaceUnknown(at('2026-09-21', '03:00'))],
      extras: extras({
        post_summary: 'видео 0:09',
        caption: 'cozy morning ☕️',
        platform_file_name: 'FYP-0799_khalat-okna_master.mp4',
        ours_duration_s: 9,
        theirs_duration_s: 9,
      }),
    }),
    track({
      item_id: null,
      account: 'lora-1',
      surface: 'wall',
      evidence: [
        evidence.hubUnplanned(at('2026-09-22', '11:02'), 'wall', '1 видео 0:07 · «mirror mood 🖤»'),
      ],
      extras: extras({
        post_summary: '1 видео 0:07',
        caption: 'mirror mood 🖤',
        platform_file_name: 'IMG_2319.mp4',
        theirs_duration_s: 7,
      }),
    }),
    // «Не наше · 3» (DESIGN §9.7): posts Диана marked as not ours, each told apart by its post.
    ...(
      [
        ['2026-09-15', '16:20', 'lora-1', '1 фото', 'new page, link in bio 🔗', null],
        ['2026-09-17', '12:05', 'lora-2', '1 видео 0:12', 'go follow my bestie 💕', 12],
        ['2026-09-19', '18:40', 'lora-1', '3 фото', 'weekend sale on my other page', null],
      ] as const
    ).map(([date, time, account, summary, caption, duration]) =>
      track({
        item_id: null,
        account,
        surface: 'wall',
        evidence: [
          evidence.hubUnplanned(at(date, time), 'wall', summary),
          evidence.outside(DIANA, at(date, '21:30')),
        ],
        extras: extras({ post_summary: summary, caption, theirs_duration_s: duration }),
      }),
    ),
  ]
  const rows = [
    row({
      date: '2026-09-20',
      time: null,
      account: 'lora-3',
      surface: 'vault',
      item: 'SXT-005',
      assignee: PERSON.diana,
      album: 'SXT-005 Розовые стринги',
      requires_new_upload: true,
      mark: { kind: 'posted', at: at('2026-09-20', '14:10') },
      evidence: [
        evidence.vaultStale(
          at('2026-09-21', '10:00'),
          'SXT-005 Розовые стринги',
          '2026-08-12',
          '2026-09-20',
        ),
      ],
      extras: extras({ post_summary: 'альбом «SXT-005 Розовые стринги», обойдён 21.09' }),
    }),
  ]
  return { rows, tracks }
}
