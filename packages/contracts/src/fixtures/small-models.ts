import { mskInstant } from '../clock'
import type { CatalogEntry } from '../domain/catalog'
import type { Model } from '../domain/model'
import { exportName } from '../download-name'
import { generateCatalog, numberRange } from './catalog-generator'
import { createEvidenceFactory } from './evidence'
import { buildLoraNorms } from './models'
import { PERSON } from './people'
import { createRowBuilder, createTrackBuilder } from './plan-builder'
import type { InboxRecord, PlacementTrack, PlanRowRecord } from './world-types'

/**
 * Lily (40 objects) to check switching models, and Ари (12 objects) — an almost empty
 * library with one page where Hub is not set up (DESIGN §9.2).
 */

export function buildLilyCatalog(): CatalogEntry[] {
  return generateCatalog({
    seed: 'lily-2026-09-22',
    types: [
      {
        type: 'ppv',
        numbers: numberRange(1, 4),
        arrived_from: '2025-06-01',
        arrived_to: '2026-08-20',
      },
      {
        type: 'fyp',
        numbers: numberRange(1, 20),
        arrived_from: '2025-05-10',
        arrived_to: '2026-09-15',
      },
      {
        type: 'set',
        numbers: numberRange(1, 4),
        arrived_from: '2025-07-01',
        arrived_to: '2026-09-01',
      },
      {
        type: 'sexting',
        numbers: numberRange(1, 6),
        arrived_from: '2025-05-20',
        arrived_to: '2026-08-01',
      },
      {
        type: 'life',
        numbers: numberRange(1, 6),
        arrived_from: '2025-06-15',
        arrived_to: '2026-09-10',
      },
    ],
  })
}

export function buildAriCatalog(): CatalogEntry[] {
  return generateCatalog({
    seed: 'ari-2026-09-22',
    types: [
      { type: 'ppv', numbers: [1], arrived_from: '2026-07-20', arrived_to: '2026-07-20' },
      {
        type: 'fyp',
        numbers: numberRange(1, 6),
        arrived_from: '2026-07-01',
        arrived_to: '2026-09-18',
      },
      {
        type: 'set',
        numbers: numberRange(1, 2),
        arrived_from: '2026-07-10',
        arrived_to: '2026-09-05',
      },
      {
        type: 'life',
        numbers: numberRange(1, 3),
        arrived_from: '2026-07-05',
        arrived_to: '2026-09-12',
      },
    ],
  })
}

/** FYP placements by Hub on the Fansly pages that have it. */
export function smallModelTracks(model: Model, entries: readonly CatalogEntry[]): PlacementTrack[] {
  const track = createTrackBuilder(`t-${model.code}`)
  const evidence = createEvidenceFactory(`e-${model.code}`)
  const withHub = model.accounts.filter((account) => account.hub_page !== null)
  return entries
    .filter((entry) => entry.type === 'fyp')
    .flatMap((entry, index) =>
      withHub
        .filter((_, accountIndex) => (index + accountIndex) % 2 === 0)
        .map((account) =>
          track({
            item_id: entry.id,
            account: account.code,
            surface: 'fyp',
            evidence: [evidence.hubExact(mskInstant(entry.arrived_on, '03:02'), 'file')],
            stats: { views: 90 + index * 23, likes: 6 + index, on: '2026-09-22' },
          }),
        ),
    )
}

/** Имя, под которым Hub увидел фуп Lily: выдача по строке плана (naming §6). */
function issuedLilyName(entries: readonly CatalogEntry[], id: string): string {
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry) return id
  return exportName({
    id: entry.id,
    title: entry.title,
    title_en: entry.title_en,
    role: 'master',
    slot: { account: 'lilly-1', date: '2026-09-22', time: '03:00' },
    ext: 'mp4',
  })
}

/** Lily today: one FYP confirmed by Hub, one wall in the scheduler — nothing to do. */
export function lilyPlan(entries: readonly CatalogEntry[]): {
  rows: PlanRowRecord[]
  tracks: PlacementTrack[]
} {
  const row = createRowBuilder('r-lily')
  const evidence = createEvidenceFactory('e-lily-plan')
  const built = [
    row({
      date: '2026-09-22',
      time: '03:00',
      account: 'lilly-1',
      surface: 'fyp',
      item: 'FYP-0020',
      assignee: PERSON.diana,
      mark: { kind: 'scheduled', at: mskInstant('2026-09-21', '11:40') },
      evidence: [
        evidence.hubExact(
          mskInstant('2026-09-22', '03:01'),
          'file_name',
          issuedLilyName(entries, 'FYP-0020'),
        ),
      ],
    }),
    row({
      date: '2026-09-22',
      time: '20:00',
      account: 'lilly-2',
      surface: 'wall',
      item: 'SET-004',
      assignee: PERSON.diana,
      mark: { kind: 'scheduled', at: mskInstant('2026-09-21', '11:42') },
    }),
  ]
  return {
    rows: built.map((entry) => entry.row),
    tracks: built.flatMap((entry) => (entry.track ? [entry.track] : [])),
  }
}

export function lilyInbox(): InboxRecord[] {
  return [
    {
      target_item: null,
      prepare_started_at: null,
      ready_at: null,
      group: {
        id: 'g-lily-life',
        title: 'Лайф · 8 фото',
        source_path: 'Lilly / 6. Life / life_кафе_21.09.26',
        root: '6. Life',
        arrived_at: mskInstant('2026-09-22', '09:05'),
        size_bytes: 21_000_000,
        file_count: 8,
        state: { kind: 'ready', note: { kind: 'new' } },
        accept_block: null,
        fields: {
          type: 'life',
          title: 'Кафе с подругой',
          description: '',
          tags: [],
          ppv_kind: null,
          raw_purpose: null,
          channel: null,
          collection: null,
          second_person: false,
          fan_name: null,
          order_id: null,
          shot_on: '2026-09-21',
        },
        hints: [],
        files: Array.from({ length: 8 }, (_, index) => ({
          key: `f${index + 1}`,
          file_name: `IMG_${5100 + index}.JPG`,
          role: 'photo' as const,
          role_label: `фото ${index + 1}`,
          media: 'photo' as const,
          position: index + 1,
          duration_s: null,
          size_bytes: 2_600_000,
          thumb: { key: `draft:g-lily-life/${index + 1}`, ratio: '3:4' as const },
          shot_at: mskInstant('2026-09-21', '13:00'),
        })),
        candidates: [],
        archive_entries: null,
        target_item: null,
        uploaded_by: null,
        version: 1,
      },
    },
  ]
}

/** Norms of the small models: a FYP a day on each page with Hub. */
export function smallModelNorms(model: Model) {
  const template = buildLoraNorms().find((norm) => norm.account === 'lora-2')
  if (!template) return []
  return model.accounts.map((account) => ({
    ...template,
    account: account.code,
    usual_assignee: account.usual_assignee,
  }))
}
