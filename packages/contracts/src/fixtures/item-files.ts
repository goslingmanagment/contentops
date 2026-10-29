import { addMinutes, mskInstant } from '../clock'
import type { CatalogEntry } from '../domain/catalog'
import type { LocalDate } from '../domain/common'
import type { FileRole, ItemFile, LifeAssignment, MasterFrame, MediaKind } from '../domain/files'
import { FILE_ROLE_LABEL } from '../domain/files'
import type { OldName } from '../domain/item'
import type { MarkupField, MarkupState } from '../domain/markup'
import { translitWords } from '../download-name'
import { hashString } from '../hash'
import { createRandom } from './random'

/**
 * Files, frames, markup and Я.Диск paths of an object, synthesized from its index entry
 * with a seed from the ID. Detailed objects of §9.3 override what they need.
 */

const PHOTO_BYTES = 2_400_000
const VIDEO_BYTES_PER_SECOND = 3_900_000

interface FileSpec {
  key: string
  role: FileRole
  media: MediaKind
  position: number | null
  file_name: string
  duration_s?: number | null
  assignment?: LifeAssignment | null
  selected?: boolean | null
  processed?: boolean | null
  flags?: ('extra' | 'optional')[]
  label?: string
}

function fileFrom(entry: CatalogEntry, spec: FileSpec): ItemFile {
  const vertical = entry.type !== 'promo'
  const isVideo = spec.media === 'video'
  const duration = spec.duration_s ?? null
  return {
    key: spec.key,
    role: spec.role,
    label:
      spec.label ??
      (spec.role === 'photo' && spec.position
        ? `фото ${spec.position}`
        : FILE_ROLE_LABEL[spec.role]),
    media: spec.media,
    position: spec.position,
    file_name: spec.file_name,
    duration_s: duration,
    width: vertical ? 2160 : 3840,
    height: vertical ? 3840 : 2160,
    size_bytes: isVideo ? Math.round((duration ?? 10) * VIDEO_BYTES_PER_SECOND) : PHOTO_BYTES,
    thumb: { key: `${entry.id}/${spec.key}`, ratio: isVideo ? '9:16' : '3:4' },
    current_version: 1,
    versions: [{ no: 1, on: entry.arrived_on, reason: null, duration_s: duration }],
    state: { kind: 'ready' },
    selected: spec.selected ?? null,
    processed: spec.processed ?? null,
    assignment: spec.assignment ?? null,
    flags: spec.flags ?? [],
    shot_at: null,
    source: null,
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

function numbered(count: number, make: (position: number) => FileSpec): FileSpec[] {
  return Array.from({ length: count }, (_, index) => make(index + 1))
}

function photos(count: number, prefix = 'ph'): FileSpec[] {
  return numbered(count, (position) => ({
    key: `${prefix}${pad(position)}`,
    role: 'photo',
    media: 'photo',
    position,
    file_name: `${position}.jpg`,
  }))
}

function master(entry: CatalogEntry): FileSpec {
  return {
    key: 'master',
    role: 'master',
    media: 'video',
    position: null,
    file_name: 'full.mov',
    duration_s: entry.duration_s,
  }
}

function lifeAssignment(entry: CatalogEntry, position: number): LifeAssignment | null {
  const chats = entry.life_chat_count ?? 0
  const feed = entry.life_feed_count ?? 0
  if (position <= Math.floor(chats / 2)) return 'both'
  if (position <= chats) return 'chats'
  if (position <= chats + feed) return 'feed'
  return null
}

const FILE_SPECS: Record<CatalogEntry['type'], (entry: CatalogEntry) => FileSpec[]> = {
  ppv: (entry) => [
    master(entry),
    ...(entry.has_teaser
      ? [
          {
            key: 'teaser',
            role: 'teaser' as const,
            media: 'video' as const,
            position: null,
            file_name: 'promo.mov',
            duration_s: 32,
          },
        ]
      : []),
    ...photos(entry.photo_count ?? 0),
  ],
  custom: (entry) =>
    entry.photo_custom
      ? photos(entry.photo_count ?? 0)
      : [{ ...master(entry), file_name: `${entry.title.toLowerCase()}.mov` }],
  set: (entry) =>
    numbered(entry.photo_count ?? 0, (position) => ({
      key: `ed${pad(position)}`,
      role: 'photo',
      media: 'photo',
      position,
      file_name: `IMG_${7400 + position}.JPG`,
      selected: position <= (entry.selected_count ?? 0),
      processed: position <= (entry.processed_count ?? 0),
    })),
  sexting: (entry) => [
    ...numbered(entry.photo_count ?? 0, (position) => ({
      key: `pic${pad(position)}`,
      role: 'photo' as const,
      media: 'photo' as const,
      position,
      file_name: `${position}.jpg`,
      flags: position > (entry.photo_count ?? 0) - 2 ? ['extra' as const] : [],
    })),
    ...numbered(entry.video_count ?? 0, (position) => ({
      key: `clip${pad(position)}`,
      role: 'clip' as const,
      media: 'video' as const,
      position: (entry.photo_count ?? 0) + position,
      file_name: `IMG_${7560 + position}.mov`,
      duration_s: 20 + position * 7,
      label: `видео ${position}`,
    })),
  ],
  fyp: (entry) => [
    {
      key: 'montage',
      role: 'montage',
      media: 'video',
      position: null,
      file_name: 'montage.mov',
      duration_s: entry.duration_s,
    },
  ],
  life: (entry) => [
    ...numbered(entry.photo_count ?? 0, (position) => ({
      key: `ph${pad(position)}`,
      role: 'photo' as const,
      media: 'photo' as const,
      position,
      file_name: `IMG_${8100 + position}.HEIC`,
      assignment: lifeAssignment(entry, position),
    })),
    ...numbered(entry.video_count ?? 0, (position) => ({
      key: `vid${pad(position)}`,
      role: 'clip' as const,
      media: 'video' as const,
      position: null,
      file_name: `IMG_${8200 + position}.MOV`,
      duration_s: 12 + position * 5,
      label: `видео ${position}`,
    })),
  ],
  raw: (entry) =>
    numbered((entry.photo_count ?? 0) + (entry.video_count ?? 0), (position) => ({
      key: `raw${pad(position)}`,
      role: 'raw' as const,
      media: position <= (entry.video_count ?? 0) ? ('video' as const) : ('photo' as const),
      position,
      file_name: `IMG_${1500 + position}.${position <= (entry.video_count ?? 0) ? 'MOV' : 'JPG'}`,
      duration_s: position <= (entry.video_count ?? 0) ? 8 + position * 3 : null,
    })),
  promo: () => [],
}

/**
 * Length of a promo clip for «▶ 0:15» (DESIGN §7.6): the object file's own length; a
 * material taken as video from a still frame gets a short stable length by its key.
 */
export function clipDuration(files: readonly ItemFile[], key: string, itemId: string): number {
  const own = files.find((file) => file.key === key)?.duration_s
  return own ?? 8 + (hashString(`${itemId}/${key}`) % 33)
}

/** Files of an object in role order; raw files get shooting times across the day. */
export function synthesizeFiles(entry: CatalogEntry): ItemFile[] {
  const files = FILE_SPECS[entry.type](entry).map((spec) => fileFrom(entry, spec))
  if (entry.type === 'raw' && entry.shot_on) {
    const start = mskInstant(entry.shot_on, '14:02')
    files.forEach((file, index) => {
      file.shot_at = addMinutes(start, index * 2)
    })
  }
  if (entry.version_count > 1) {
    const master = files.find((file) => file.role === 'master')
    if (master) {
      master.current_version = entry.version_count
      master.versions = [
        { no: 1, on: entry.arrived_on, reason: null, duration_s: master.duration_s },
        { no: 2, on: entry.arrived_on, reason: 'перемонтаж', duration_s: master.duration_s },
      ]
    }
  }
  return files
}

/** «Кадры мастера»: ten frames at equal steps of a video object. */
export function synthesizeFrames(entry: CatalogEntry): MasterFrame[] {
  if (!entry.duration_s || (entry.type !== 'ppv' && entry.type !== 'custom')) return []
  const duration = entry.duration_s
  return Array.from({ length: 10 }, (_, index) => ({
    t_s: Math.round((duration * (index + 0.5)) / 10),
    thumb: { key: `${entry.id}/frame${pad(index + 1)}`, ratio: '9:16' },
  }))
}

function fieldStatus(state: MarkupState, key: 'title' | 'tags'): MarkupField['status'] {
  if (state === 'confirmed') return 'confirmed'
  if (state === 'partial' && key === 'title') return 'confirmed'
  return 'draft_import'
}

/** Markup fields of an object from its summary state. */
export function synthesizeMarkup(entry: CatalogEntry, confirmedBy = 'Диана'): MarkupField[] {
  const confirmedAt = mskInstant(entry.arrived_on, '18:00')
  const confirmed = (status: MarkupField['status']) =>
    status === 'confirmed'
      ? { confirmed_by: confirmedBy, confirmed_at: confirmedAt }
      : { confirmed_by: null, confirmed_at: null }
  const titleStatus = fieldStatus(entry.markup, 'title')
  const tagsStatus = fieldStatus(entry.markup, 'tags')
  return [
    {
      field: { key: 'title', value: entry.title },
      status: titleStatus,
      version: 1,
      ...confirmed(titleStatus),
      source_hint: titleStatus === 'confirmed' ? null : 'из имени папки',
    },
    {
      field: { key: 'tags', value: entry.tags },
      status: tagsStatus,
      version: 1,
      ...confirmed(tagsStatus),
      source_hint: tagsStatus === 'confirmed' ? null : 'из старого имени',
    },
    {
      field: { key: 'description', value: '' },
      status: 'empty',
      version: 1,
      confirmed_by: null,
      confirmed_at: null,
      source_hint: null,
    },
    {
      field: { key: 'timeline', value: [] },
      status: 'empty',
      version: 1,
      confirmed_by: null,
      confirmed_at: null,
      source_hint: null,
    },
  ]
}

/** Имя папки на Я.Диске, как их называли люди: «Чулки у окна» → `chulki_u_okna`. */
function folderSlug(title: string): string {
  return translitWords(title).join('_')
}

function shortDate(date: LocalDate): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(2, 4)}`
}

/** Path of the object on the model's Я.Диск. */
export function ydiskPathFor(entry: CatalogEntry): string {
  const slug = folderSlug(entry.title)
  const date = shortDate(entry.shot_on ?? entry.arrived_on)
  switch (entry.type) {
    case 'ppv':
      return entry.ppv_kind === 'bundle'
        ? `1. PPV / Bundles / [${entry.id}]_${slug}_${date}`
        : `1. PPV / [${entry.id}]_${slug}_${date}`
    case 'fyp':
      return entry.steady_content
        ? `2. FYP / SteadyContent / ${entry.id.slice(4)}.mov`
        : `2. FYP / Posted / ${entry.id}_${slug}.mov`
    case 'custom':
      return entry.photo_custom
        ? `3. Customs / ${entry.title}`
        : `3. Customs / ${entry.duration_s ? formatClockDuration(entry.duration_s) : ''} ${entry.title.toLowerCase()}.mov`
    case 'set':
      return `4. Sets / Posted sets / set_${slug}_${date}`
    case 'sexting':
      return `5. Sextings / sexting_${entry.id.slice(4)}_${slug}_${date}`
    case 'life':
      return `6. Life / posted / Life_${slug}_${date}`
    case 'raw':
      return `8. Other / ${date}`
    case 'promo':
      return `9. SMM / ${entry.channel ?? ''} / ${entry.title}`
  }
}

function formatClockDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${pad(Math.round(seconds % 60))}`
}

/** Old names that search and «Старые имена» know; aliases become old numbers or albums. */
export function oldNamesFor(entry: CatalogEntry): OldName[] {
  const random = createRandom(`old-names:${entry.id}`)
  const names: OldName[] = entry.aliases.map((alias) => ({
    name: alias,
    kind: /^[A-Z]+-\d+$/.test(alias) ? ('number' as const) : ('album' as const),
    with_fan_name: false,
  }))
  if (entry.type === 'fyp' && !entry.steady_content && random.chance(0.7)) {
    names.push({
      name: `used${random.int(1, 3)}_${shortDate(entry.arrived_on).slice(0, 5)}.mov`,
      kind: 'file',
      with_fan_name: false,
    })
  }
  if (entry.type === 'custom' && entry.fan_name === 'yes') {
    const fan = `фан_${random.int(1000, 3999)}`
    names.push({
      name: `${formatClockDuration(entry.duration_s ?? 0)} ${fan} ${entry.title.toLowerCase()}.mov`,
      kind: 'file',
      with_fan_name: true,
    })
  }
  return names
}
