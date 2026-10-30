import { addDays, daysBetween } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { LocalDate, ThumbRef } from '@contentops/contracts/domain/common'
import type { ItemId, ItemType } from '@contentops/contracts/domain/item-type'
import { formatItemId } from '@contentops/contracts/domain/item-type'
import type { MarkupState } from '@contentops/contracts/domain/markup'
import { createRandom, type Random } from './random'
import { generatedTags, generatedTitle } from './vocabulary'

/**
 * Generator of a model catalog with a fixed seed. Numbers, arrival windows and
 * distributions follow the real Я.Диск of Лора (`research/07-data-sizing.md` §1.2–1.3).
 */

export interface TypePlan {
  type: ItemType
  numbers: readonly number[]
  arrived_from: LocalDate
  arrived_to: LocalDate
}

export interface CatalogPlan {
  seed: string
  types: readonly TypePlan[]
}

function coverRatio(type: ItemType): ThumbRef['ratio'] {
  return type === 'fyp' ? '9:16' : '3:4'
}

function blankEntry(id: ItemId, type: ItemType, arrivedOn: LocalDate): CatalogEntry {
  return {
    id,
    type,
    title: '',
    tags: [],
    markup: 'draft',
    cover: { key: id, ratio: coverRatio(type) },
    duration_s: null,
    photo_count: null,
    video_count: null,
    version_count: 1,
    has_teaser: false,
    arrived_on: arrivedOn,
    shot_on: arrivedOn,
    ppv_kind: null,
    raw_purpose: null,
    ppv_made_as: null,
    fan_name: null,
    second_person: false,
    delivered_on: null,
    selected_count: null,
    processed_count: null,
    life_unassigned: null,
    life_chat_count: null,
    life_feed_count: null,
    steady_content: false,
    photo_custom: false,
    aliases: [],
    order_id: null,
    channel: null,
    size_bytes: null,
  }
}

function markupState(random: Random): MarkupState {
  const draw = random.next()
  if (draw < 0.25) return 'confirmed'
  if (draw < 0.35) return 'partial'
  return 'draft'
}

type Shaper = (entry: CatalogEntry, random: Random) => void

const minutes = (value: number) => Math.round(value * 60)

const SHAPERS: Record<ItemType, Shaper> = {
  ppv: (entry, random) => {
    entry.duration_s = minutes(random.triangular(0.5, 4.5, 13.5))
    entry.photo_count = random.chance(0.7) ? random.int(8, 22) : 0
    entry.has_teaser = random.chance(0.85)
    entry.version_count = random.chance(0.1) ? 2 : 1
  },
  fyp: (entry, random) => {
    entry.duration_s = random.int(6, 12)
  },
  custom: (entry, random) => {
    entry.duration_s = minutes(random.triangular(2.7, 8, 15.3))
    entry.fan_name = random.chance(0.5) ? 'yes' : random.chance(0.7) ? 'no' : 'unknown'
    entry.delivered_on = entry.arrived_on
    entry.version_count = random.chance(0.15) ? 2 : 1
  },
  set: (entry, random) => {
    const frames = Math.round(random.triangular(14, 21, 60))
    entry.photo_count = frames
    entry.selected_count = Math.min(frames, Math.round(frames * random.triangular(0.3, 0.45, 0.7)))
    entry.processed_count = random.int(0, Math.min(10, entry.selected_count))
  },
  sexting: (entry, random) => {
    entry.photo_count = random.int(40, 130)
    entry.video_count = random.int(8, 28)
  },
  life: (entry, random) => {
    const photos = Math.round(random.triangular(2, 10, 40))
    entry.photo_count = photos
    entry.video_count = random.chance(0.3) ? random.int(1, 3) : 0
    const chats = random.chance(0.6) ? random.int(1, Math.max(1, Math.floor(photos / 2))) : 0
    const unassigned = random.chance(0.3) ? random.int(1, Math.max(1, photos - chats)) : 0
    entry.life_chat_count = chats
    entry.life_unassigned = Math.min(unassigned, photos - chats)
    entry.life_feed_count = Math.max(0, photos - chats - entry.life_unassigned)
  },
  raw: (entry, random) => {
    const files = Math.round(random.triangular(1, 5, 36))
    entry.video_count = Math.round(files * random.next())
    entry.photo_count = files - entry.video_count
    entry.raw_purpose = random.pick(['fyp', 'ppv', 'mailing', 'unknown'] as const)
  },
  promo: (entry, random) => {
    entry.video_count = random.int(12, 120)
    entry.photo_count = random.chance(0.3) ? random.int(10, 90) : 0
    entry.size_bytes = entry.video_count * random.int(20, 60) * 1_000_000
  },
}

function arrivalFor(plan: TypePlan, index: number, random: Random): LocalDate {
  const span = daysBetween(plan.arrived_from, plan.arrived_to)
  const steps = Math.max(1, plan.numbers.length - 1)
  const base = Math.round((span * index) / steps)
  const jitter = random.int(-2, 2)
  return addDays(plan.arrived_from, Math.min(span, Math.max(0, base + jitter)))
}

/** Generates entries for every number of every type; deterministic for the same plan. */
export function generateCatalog(plan: CatalogPlan): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const typePlan of plan.types) {
    const random = createRandom(`${plan.seed}:${typePlan.type}`)
    typePlan.numbers.forEach((number, index) => {
      const id = formatItemId(typePlan.type, number)
      const arrivedOn = arrivalFor(typePlan, index, random)
      const entry = blankEntry(id, typePlan.type, arrivedOn)
      entry.shot_on = addDays(arrivedOn, -random.int(0, 3))
      SHAPERS[typePlan.type](entry, random)
      entry.title = generatedTitle(typePlan.type, random, entry.shot_on)
      entry.tags = generatedTags(random)
      entry.markup = markupState(random)
      entries.push(entry)
    })
  }
  return entries
}

/** `from..to` inclusive, without the listed gaps. */
export function numberRange(from: number, to: number, gaps: readonly number[] = []): number[] {
  const numbers: number[] = []
  for (let number = from; number <= to; number++) if (!gaps.includes(number)) numbers.push(number)
  return numbers
}

/** `count` numbers spread over `1..max`, always containing `required`. */
export function sparseNumbers(
  seed: string,
  count: number,
  max: number,
  required: readonly number[],
): number[] {
  const random = createRandom(seed)
  const pool = numberRange(1, max).filter((number) => !required.includes(number))
  const picked = random.sample(pool, count - required.length)
  return [...picked, ...required].sort((left, right) => left - right)
}
