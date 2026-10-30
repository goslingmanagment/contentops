import type { ItemType } from '@contentops/contracts/domain/item-type'
import type { MarkupField, Tag, TimelineSegment } from '@contentops/contracts/domain/markup'
import { synthesizeMarkup } from './item-files'
import type { ItemRecord, ModelWorld } from './world-types'

/**
 * Разметка ИИ в режиме `?demo=ai-on` (DESIGN §4.20): у каждого объекта без подтверждённой
 * разметки черновик от ИИ — название, теги, описание и у видео хронология. Подтверждённое
 * человеком ИИ не трогает. Описание сразу ищется, как и в продукте.
 */

const TIMELINE_TYPES = new Set(['ppv', 'custom'])

/**
 * Описание словами КМ, а не повтор тегов: действие, одежда, место и настроение
 * складываются в одну фразу — «Медленный тизинг в нейлоне и на каблуках у зеркала».
 */
const ACTION: Record<string, string> = {
  teasing: 'медленный тизинг',
  striptease: 'стриптиз',
  dance: 'танец',
  yoga: 'йога',
  anal: 'анал',
  blowjob: 'минет',
  toy: 'с игрушкой',
  try_on: 'примерка',
  shower: 'в душе',
}

const LOOK: Record<string, string> = {
  stockings: 'в чулках',
  lace: 'в кружеве',
  heels: 'на каблуках',
  bodysuit: 'в боди',
  thong: 'в стрингах',
  nylon: 'в нейлоне',
  tights: 'в колготках',
  red: 'в красном',
  black: 'в чёрном',
  cake: 'с тортом',
}

const PLACE: Record<string, string> = {
  bedroom: 'в спальне',
  bathroom: 'в ванной',
  office: 'в офисе',
  hotel: 'в отеле',
  mirror: 'у зеркала',
}

const MOOD: Record<string, string> = {
  tender: 'нежно',
  playful: 'игриво',
  bold: 'дерзко',
  cozy: 'уютно',
  evening: 'вечерний свет',
}

/** Чем начать фразу, если в тегах нет действия. */
const SUBJECT: Record<ItemType, string> = {
  ppv: 'видео',
  custom: 'видео',
  fyp: 'короткое видео',
  set: 'фото',
  sexting: 'секстинг',
  life: 'кадры',
  raw: 'съёмка',
  promo: 'подборка',
}

function phrases(keys: readonly string[], table: Record<string, string>): string[] {
  return keys.flatMap((key) => {
    const phrase = table[key]
    return phrase ? [phrase] : []
  })
}

function joined(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} и ${parts.at(-1)}`
}

function describedBy(type: ItemType, keys: readonly string[]): string {
  if (keys.length === 0) return ''
  const [action = SUBJECT[type], ...more] = phrases(keys, ACTION)
  const head = more.length > 0 ? `${action}, ${more.join(', ')}` : action
  const tail = [joined(phrases(keys, LOOK)), ...phrases(keys, PLACE)].filter(Boolean).join(' ')
  const [mood] = phrases(keys, MOOD)
  const sentence = [head, tail].filter(Boolean).join(' ') + (mood ? `, ${mood}` : '')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

function timelineOf(record: ItemRecord, names: readonly string[]): TimelineSegment[] {
  const duration = record.entry.duration_s
  if (!duration || !TIMELINE_TYPES.has(record.entry.type) || names.length === 0) return []
  const steps = names.slice(0, 3)
  return steps.map((label, index) => ({
    start_s: Math.round((duration * index) / steps.length),
    label,
  }))
}

function aiField(field: MarkupField, value: MarkupField['field']): MarkupField {
  return {
    ...field,
    field: value,
    status: 'draft_ai',
    confirmed_by: null,
    confirmed_at: null,
    source_hint: null,
  }
}

function aiMarkup(record: ItemRecord, names: readonly string[]): MarkupField[] {
  const current = record.markup ?? synthesizeMarkup(record.entry)
  const description = describedBy(record.entry.type, record.entry.tags)
  const timeline = timelineOf(record, names)
  return current.map((field) => {
    if (field.status === 'confirmed') return field
    switch (field.field.key) {
      case 'description':
        return description ? aiField(field, { key: 'description', value: description }) : field
      case 'timeline':
        return timeline.length > 0 ? aiField(field, { key: 'timeline', value: timeline }) : field
      default:
        return field.status === 'empty' ? field : aiField(field, field.field)
    }
  })
}

/** Черновики ИИ для всех объектов модели, чья разметка ещё не подтверждена целиком. */
export function applyAiDrafts(model: ModelWorld, dictionary: readonly Tag[]): void {
  const russian = new Map(dictionary.map((tag) => [tag.key, tag.ru ?? tag.key]))
  for (const record of model.items.values()) {
    if (record.lifecycle.state !== 'active' || record.entry.markup === 'confirmed') continue
    const names = record.entry.tags.map((key) => russian.get(key) ?? key)
    record.markup = aiMarkup(record, names)
    const description = record.markup.find((field) => field.field.key === 'description')?.field
    if (description?.key === 'description') record.description = description.value
  }
}
