import type { AccountCode } from '@contentops/contracts/domain/common'
import type { Account, Model } from '@contentops/contracts/domain/model'
import type { NormKind, WeekNorm } from '@contentops/contracts/domain/plan'
import { PERSON } from './people'
import type { CoverageRecord } from './world-types'

/** Models and pages of DESIGN §9.2. */

function account(
  model: string,
  code: AccountCode,
  label: string,
  handle: string,
  options: Pick<Account, 'platform' | 'hub_page' | 'usual_assignee' | 'uniq_level' | 'position'>,
): Account {
  return { code, model, label, handle, ...options }
}

export const LORA_ACCOUNTS: readonly Account[] = [
  account('lora', 'lora-1', 'Fansly 1', 'LoraVie', {
    platform: 'fansly',
    hub_page: 'lora-1',
    usual_assignee: PERSON.diana,
    uniq_level: 'soft',
    position: 0,
  }),
  account('lora', 'lora-2', 'Fansly 2', 'LoraViex', {
    platform: 'fansly',
    hub_page: 'lora-2',
    usual_assignee: PERSON.diana,
    uniq_level: 'soft',
    position: 1,
  }),
  account('lora', 'lora-3', 'Fansly 3', 'LoraViexx', {
    platform: 'fansly',
    hub_page: 'lora-3',
    usual_assignee: PERSON.diana,
    uniq_level: 'trim',
    position: 2,
  }),
  account('lora', 'lora-vip-of', 'OF VIP', 'loravievip', {
    platform: 'onlyfans',
    hub_page: 'lora-vip-of',
    usual_assignee: PERSON.nikita,
    uniq_level: 'soft',
    position: 3,
  }),
  account('lora', 'lora-of', 'OF Free', 'loravie', {
    platform: 'onlyfans',
    hub_page: 'lora-of',
    usual_assignee: PERSON.nikita,
    uniq_level: 'soft',
    position: 4,
  }),
]

export const LORA: Model = {
  code: 'lora',
  name: 'Лора',
  name_genitive: 'Лоры',
  timezone: 'Europe/Moscow',
  accounts: [...LORA_ACCOUNTS],
}

export const LILY: Model = {
  code: 'lily',
  name: 'Lily',
  name_genitive: 'Lily',
  timezone: 'Europe/Moscow',
  accounts: [
    account('lily', 'lilly-1', 'Fansly 1', 'WetLillys', {
      platform: 'fansly',
      hub_page: 'lilly-1',
      usual_assignee: PERSON.diana,
      uniq_level: 'soft',
      position: 0,
    }),
    account('lily', 'lilly-2', 'Fansly 2', 'WetLili', {
      platform: 'fansly',
      hub_page: 'lilly-2',
      usual_assignee: PERSON.diana,
      uniq_level: 'soft',
      position: 1,
    }),
  ],
}

export const ARI: Model = {
  code: 'ari',
  name: 'Ари',
  name_genitive: 'Ари',
  timezone: 'Europe/Moscow',
  accounts: [
    account('ari', 'ari-1', 'Fansly 1', '@itsaribae', {
      platform: 'fansly',
      hub_page: 'ari-1',
      usual_assignee: null,
      uniq_level: 'soft',
      position: 0,
    }),
    account('ari', 'ari-2', 'Fansly 2', '@itsaribaex', {
      platform: 'fansly',
      hub_page: null,
      usual_assignee: null,
      uniq_level: 'soft',
      position: 1,
    }),
  ],
}

/** Hub capture floors from `research/07-data-sizing.md` §2.1. */
export const COVERAGE: Record<AccountCode, CoverageRecord> = {
  'lora-1': { posts_complete: true, vault_complete: false, visible_from: '2025-01-19' },
  'lora-2': { posts_complete: true, vault_complete: true, visible_from: '2025-02-01' },
  'lora-3': { posts_complete: false, vault_complete: true, visible_from: '2025-02-08' },
  'lora-vip-of': { posts_complete: true, vault_complete: false, visible_from: '2025-09-06' },
  'lora-of': { posts_complete: true, vault_complete: false, visible_from: '2025-09-03' },
  'lilly-1': { posts_complete: true, vault_complete: true, visible_from: '2024-05-09' },
  'lilly-2': { posts_complete: true, vault_complete: true, visible_from: '2025-11-22' },
  'ari-1': { posts_complete: true, vault_complete: true, visible_from: '2026-06-30' },
  'ari-2': { posts_complete: false, vault_complete: false, visible_from: null },
}

type NormRow = { kind: NormKind; days: readonly number[]; time: string | null }

function norm(
  code: AccountCode,
  rows: readonly NormRow[],
  assignee: string | null,
  release: WeekNorm['release'] = null,
): WeekNorm {
  const kinds: NormKind[] = ['fyp', 'wall', 'life_vault', 'story']
  return {
    account: code,
    cells: kinds.map((kind) => {
      const row = rows.find((candidate) => candidate.kind === kind)
      const perDay = [0, 0, 0, 0, 0, 0, 0]
      for (const day of row?.days ?? []) perDay[day] = 1
      return { kind, per_day: perDay, time: row?.time ?? null }
    }),
    release,
    usual_assignee: assignee,
    uniq_level: 'soft',
    version: 1,
  }
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** Norms of Лора by Hub data for 30 days (DESIGN §9.6): 51 rows a week, 60 in a release week. */
export function buildLoraNorms(): WeekNorm[] {
  return [
    norm(
      'lora-1',
      [
        { kind: 'fyp', days: [1, 3, 5, 6], time: '03:00' },
        { kind: 'wall', days: EVERY_DAY, time: '20:00' },
        { kind: 'life_vault', days: [1], time: null },
      ],
      PERSON.diana,
    ),
    ...(['lora-2', 'lora-3'] as const).map((code) =>
      norm(
        code,
        [
          { kind: 'fyp', days: EVERY_DAY, time: '03:00' },
          { kind: 'wall', days: EVERY_DAY, time: '20:00' },
          { kind: 'life_vault', days: [1], time: null },
        ],
        PERSON.diana,
      ),
    ),
    norm('lora-vip-of', [{ kind: 'wall', days: [0, 1, 2, 3, 4], time: '20:00' }], PERSON.nikita, {
      every_weeks: 2,
      weekday: 3,
      time: '20:00',
    }),
    norm('lora-of', [{ kind: 'wall', days: [1, 3, 5, 6], time: '19:00' }], PERSON.nikita),
  ]
}
