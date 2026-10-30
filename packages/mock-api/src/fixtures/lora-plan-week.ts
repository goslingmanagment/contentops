import { mskInstant } from '@contentops/contracts/clock'
import type { AccountCode, LocalDate, LocalTime } from '@contentops/contracts/domain/common'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { PersonName } from '@contentops/contracts/domain/placement'
import type { EvidenceFactory } from './evidence'
import { PERSON } from './people'
import type { BuiltRow, RowSpec } from './plan-builder'

/**
 * The week of 21–27.09.2026 (DESIGN §9.6, §9.7): Monday in the past, Tuesday is today,
 * Wednesday–Friday laid out, Saturday and Sunday still empty places of the norm.
 */

export const DIANA: PersonName = { name: 'Диана', gender: 'f' }
export const NIKITA: PersonName = { name: 'Никита', gender: 'm' }

export interface WeekContext {
  row: (spec: RowSpec) => BuiltRow
  evidence: EvidenceFactory
  titleOf: (id: ItemId) => string
  /**
   * Name of the file a row handed out (naming §6): the first file of «Для заливки» with the
   * page, day and slot of the row, `_uN` for a FYP version.
   */
  issued: (
    item: ItemId,
    account: AccountCode,
    date: LocalDate,
    time: LocalTime | null,
    at?: { uniq?: number; version?: number },
  ) => string
}

const at = (date: LocalDate, time: LocalTime) => mskInstant(date, time)
const scheduledSunday = { kind: 'scheduled' as const, at: at('2026-09-20', '22:10') }
const scheduledMonday = { kind: 'scheduled' as const, at: at('2026-09-21', '11:30') }

function monday(context: WeekContext): BuiltRow[] {
  const { row, evidence, issued } = context
  const date = '2026-09-21'
  return [
    row({
      date,
      time: '20:00',
      account: 'lora-1',
      surface: 'wall',
      item: 'SET-071',
      assignee: PERSON.diana,
      mark: scheduledSunday,
      evidence: [
        evidence.hubExact(
          at(date, '20:02'),
          'file_name',
          issued('SET-071', 'lora-1', date, '20:00'),
        ),
      ],
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-2',
      surface: 'fyp',
      item: 'FYP-0802',
      version: { no: 1, level: 'soft' },
      assignee: PERSON.diana,
      evidence: [
        evidence.hubExact(
          at(date, '03:04'),
          'file_name',
          issued('FYP-0802', 'lora-2', date, '03:00', { uniq: 1 }),
          { ours_s: 8, theirs_s: 8 },
        ),
      ],
      stats: { views: 1_860, on: '2026-09-22' },
    }),
    row({
      date,
      time: '18:00',
      account: 'lora-2',
      surface: 'wall',
      item: 'SET-072',
      assignee: PERSON.diana,
      mark: scheduledSunday,
      evidence: [
        evidence.hubCandidate(at(date, '17:58'), -2, '22 фото'),
        evidence.hubCandidate(at(date, '18:07'), 7, '22 фото'),
      ],
      extras: {
        post_summary: '22 фото',
        caption: null,
        platform_file_name: null,
        issued_name: issued('SET-072', 'lora-2', date, '18:00'),
        issued_to: 'Диана · 20.09 22:05',
        sizes: null,
        hint: null,
        attachments: [],
        ours_duration_s: null,
        theirs_duration_s: null,
      },
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-3',
      surface: 'fyp',
      item: 'FYP-0797',
      version: { no: 2, level: 'trim' },
      assignee: PERSON.diana,
      mark: scheduledSunday,
      evidence: [evidence.hubCandidate(at(date, '03:05'), 5, '1 видео 0:11 = 0:11')],
      extras: {
        post_summary: 'видео 0:11',
        caption: 'office mood 🤍 #fyp',
        platform_file_name: 'IMG_2291.mp4',
        issued_name: issued('FYP-0797', 'lora-3', date, '03:00', { uniq: 2 }),
        issued_to: 'Диана · 20.09 22:04',
        sizes: '1080 × 1920 · 14 МБ',
        hint: null,
        attachments: [],
        ours_duration_s: 11,
        theirs_duration_s: 11,
      },
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-3',
      surface: 'wall',
      item: 'SET-070',
      assignee: PERSON.diana,
      mark: scheduledSunday,
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-vip-of',
      surface: 'wall',
      item: 'PPV-074',
      assignee: PERSON.nikita,
      evidence: [evidence.hubCandidate(at(date, '20:03'), 3, 'видео 9:41 и 2 фото')],
      extras: {
        post_summary: 'видео 9:41 и 2 фото',
        caption: 'crystals & heels ✨ full video in DM',
        platform_file_name: null,
        issued_name: issued('PPV-074', 'lora-vip-of', date, '20:00'),
        issued_to: 'Никита · 21.09 19:40',
        sizes: '2160 × 3840 · 1,1 ГБ',
        hint: null,
        attachments: [],
        ours_duration_s: 581,
        theirs_duration_s: 581,
      },
    }),
  ]
}

function tuesday(context: WeekContext): BuiltRow[] {
  const { row, evidence, issued } = context
  const date = '2026-09-22'
  return [
    row({
      date,
      time: null,
      account: 'lora-1',
      surface: 'fyp',
      item: null,
      assignee: PERSON.diana,
      created_at: at('2026-09-21', '12:40'),
      awaiting: {
        from_item: 'RAW-0214',
        expected_type: 'fyp',
        file_keys: ['raw03', 'raw04', 'raw07'],
      },
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-1',
      surface: 'wall',
      item: 'SET-074',
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-2',
      surface: 'fyp',
      item: 'FYP-0801',
      version: { no: 1, level: 'soft' },
      assignee: PERSON.diana,
      mark: scheduledSunday,
      evidence: [evidence.hubCandidate(at(date, '03:06'), 6, '1 видео 0:09 = 0:09 · имя не наше')],
      extras: {
        post_summary: 'видео 0:09',
        caption: 'mirror, mirror 🖤 #fyp #fansly',
        platform_file_name: 'IMG_2304.mp4',
        issued_name: issued('FYP-0801', 'lora-2', date, '03:00', { uniq: 1 }),
        issued_to: 'Диана · 21.09 23:40',
        sizes: '1080 × 1920 · 12 МБ',
        hint: 'в 23:40 был похожий пост',
        attachments: [],
        ours_duration_s: 9,
        theirs_duration_s: 9,
      },
    }),
    row({
      date,
      time: '11:40',
      account: 'lora-2',
      surface: 'vault',
      item: 'LIFE-191',
      assignee: PERSON.diana,
      album: 'Lifestyle',
      mark: { kind: 'posted', at: at(date, '11:42') },
      downloaded: { at: at(date, '11:31'), by: PERSON.diana, meta_stripped: true },
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-2',
      surface: 'wall',
      item: 'SET-074',
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-3',
      surface: 'fyp',
      item: 'FYP-0801',
      version: { no: 2, level: 'trim' },
      assignee: PERSON.diana,
      mark: scheduledSunday,
      evidence: [
        evidence.hubExact(
          at(date, '03:02'),
          'file_name',
          issued('FYP-0801', 'lora-3', date, '03:00', { uniq: 2 }),
          { ours_s: 9, theirs_s: 9 },
        ),
      ],
      stats: { views: 940, on: '2026-09-22' },
    }),
    row({
      date,
      time: '11:40',
      account: 'lora-3',
      surface: 'vault',
      item: 'LIFE-191',
      assignee: PERSON.diana,
      album: 'Lifestyle',
      mark: { kind: 'posted', at: at(date, '11:44') },
      evidence: [
        { ...evidence.hubExact(at(date, '11:44'), 'album'), recorded_at: at(date, '12:50') },
      ],
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-3',
      surface: 'wall',
      item: 'SET-074',
      assignee: PERSON.diana,
      mark: scheduledMonday,
      has_newer_version: true,
    }),
    row({
      date,
      time: '13:00',
      account: 'lora-vip-of',
      surface: 'story',
      item: 'PPV-075',
      assignee: PERSON.nikita,
      note: 'тизер',
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-vip-of',
      surface: 'wall',
      item: 'PPV-072',
      assignee: PERSON.nikita,
    }),
    row({
      date,
      time: '19:00',
      account: 'lora-of',
      surface: 'wall',
      item: 'SET-073',
      assignee: PERSON.nikita,
    }),
    row({
      date,
      time: '12:00',
      account: 'lora-2',
      surface: 'story',
      item: 'PPV-071',
      assignee: PERSON.diana,
      cancelled: { at: at(date, '12:30'), by: PERSON.diana, reason: 'late' },
    }),
    row({
      date,
      time: '15:00',
      account: 'lora-vip-of',
      surface: 'dm',
      item: 'PPV-070',
      assignee: PERSON.nikita,
      cancelled: { at: at(date, '10:05'), by: PERSON.nikita, reason: null },
    }),
  ]
}

function wednesday(context: WeekContext): BuiltRow[] {
  const { row } = context
  const date = '2026-09-23'
  const scheduled = (by: string) => ({ ...scheduledMonday, by })
  return [
    row({
      date,
      time: '03:00',
      account: 'lora-1',
      surface: 'fyp',
      item: 'FYP-0790',
      assignee: PERSON.diana,
      mark: scheduled(PERSON.diana),
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-1',
      surface: 'wall',
      item: 'SET-068',
      assignee: PERSON.diana,
      mark: scheduled(PERSON.diana),
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-2',
      surface: 'fyp',
      item: 'FYP-0791',
      version: { no: 1, level: 'soft' },
      assignee: PERSON.diana,
      mark: scheduled(PERSON.diana),
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-2',
      surface: 'wall',
      item: 'SET-068',
      assignee: PERSON.diana,
      mark: scheduled(PERSON.diana),
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-3',
      surface: 'fyp',
      item: 'FYP-0791',
      version: { no: 2, level: 'trim' },
      assignee: PERSON.diana,
      mark: scheduled(PERSON.diana),
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-3',
      surface: 'wall',
      item: 'SET-068',
      assignee: PERSON.diana,
      mark: scheduled(PERSON.diana),
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-vip-of',
      surface: 'wall',
      item: 'PPV-069',
      assignee: PERSON.nikita,
      mark: scheduled(PERSON.nikita),
    }),
    row({
      date,
      time: '19:00',
      account: 'lora-of',
      surface: 'wall',
      item: 'SET-066',
      assignee: PERSON.nikita,
      mark: scheduled(PERSON.nikita),
    }),
  ]
}

export const RELEASE_PPV_076 = 'rel-ppv-076'

function thursday(context: WeekContext): BuiltRow[] {
  const { row } = context
  const date = '2026-09-24'
  const createdAt = at('2026-09-22', '10:20')
  const release = (account: AccountCode, surface: 'wall' | 'dm' | 'story', time: LocalTime) =>
    row({
      date,
      time,
      account,
      surface,
      item: 'PPV-076',
      assignee: account.endsWith('of') ? PERSON.nikita : PERSON.diana,
      created_by: PERSON.diana,
      created_at: createdAt,
      release: RELEASE_PPV_076,
      // Копия для стены ещё собирается; у рассылки и тизера — готова, размер по длине.
      ...(surface === 'wall' ? { copy: { state: 'building' as const, progress: 0.4 } } : {}),
    })
  const pages: AccountCode[] = ['lora-1', 'lora-2', 'lora-3', 'lora-vip-of', 'lora-of']
  return [
    ...pages.map((account) => release(account, 'wall', '20:00')),
    ...pages
      .filter((account) => account !== 'lora-of')
      .map((account) => release(account, 'dm', '21:00')),
    ...pages.map((account) => release(account, 'story', '20:30')),
    row({
      date,
      time: '03:00',
      account: 'lora-1',
      surface: 'fyp',
      item: 'FYP-0792',
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-2',
      surface: 'fyp',
      item: 'FYP-0793',
      version: { no: 1, level: 'soft' },
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-3',
      surface: 'fyp',
      item: 'FYP-0793',
      version: { no: 2, level: 'trim' },
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
  ]
}

function friday(context: WeekContext): BuiltRow[] {
  const { row } = context
  const date = '2026-09-25'
  return [
    row({
      date,
      time: '20:00',
      account: 'lora-1',
      surface: 'wall',
      item: 'SET-065',
      assignee: PERSON.diana,
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-2',
      surface: 'fyp',
      item: 'FYP-0794',
      version: { no: 1, level: 'soft' },
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-2',
      surface: 'wall',
      item: 'SET-065',
      assignee: PERSON.diana,
    }),
    row({
      date,
      time: '03:00',
      account: 'lora-3',
      surface: 'fyp',
      item: 'FYP-0794',
      version: { no: 2, level: 'trim' },
      assignee: PERSON.diana,
      mark: scheduledMonday,
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-3',
      surface: 'wall',
      item: 'SET-065',
      assignee: PERSON.diana,
    }),
    row({
      date,
      time: '20:00',
      account: 'lora-vip-of',
      surface: 'wall',
      item: 'PPV-068',
      assignee: PERSON.nikita,
    }),
    row({
      date,
      time: null,
      account: 'lora-vip-of',
      surface: 'vault',
      item: 'SXT-012',
      assignee: PERSON.nikita,
      album: 'SXT-012 Чулки, каблуки',
    }),
  ]
}

/** All rows of the current week, Monday to Friday. */
export function buildCurrentWeek(context: WeekContext): BuiltRow[] {
  return [
    ...monday(context),
    ...tuesday(context),
    ...wednesday(context),
    ...thursday(context),
    ...friday(context),
  ]
}
