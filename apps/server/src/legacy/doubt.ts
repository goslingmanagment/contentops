import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { localDay, mediaKindOf } from '../intake/grouping'
import type { LegacyUnit } from './units'

/**
 * What the import does not take by itself (SPEC §6.3 «Группа без спора принимается сама»): a
 * folder without a number gets its type from its section only, so the import issues it a new
 * number only where the files agree with that type and make one shoot. Otherwise the group waits
 * for a person in «Приехало» (◆ «Что это?» with the question below): the type or a split is
 * theirs. The same rules for every model, by the shape of names and files: a Telegram mirror
 * (Ари's `5. Sextings/19.10.26`), a copy from a computer (`с мака 30.06`), a collection over two
 * years (`архив тизеров 2025-26`), photo sets in the sextings (`17.04.26 розовый халтер`).
 * A number in the name (`SXT-002`, `sexting_004_…`, `[PPV-032]`) settles the object as before.
 */

export type DoubtKind =
  | 'day_folder'
  | 'loose_files'
  | 'copy_or_collection'
  | 'photos_only'
  | 'no_video'
  | 'several_shoots'

export interface Doubt {
  kind: DoubtKind
  /** The question of the ◆, in the words of «Приехало». */
  text: string
}

export interface DoubtFile {
  name: string
  video: boolean
  /** The local day of shooting (`YYYY-MM-DD`): EXIF of the bytes, else of the source. */
  shotDay: string | null
}

export interface DoubtInput {
  /** The type the group proposes (`SXT`), from its section. */
  type: string | null
  /** `inbox_groups.grouping`: `folder`, `exif_day`, `upload_cluster`, `single`, `manual`. */
  grouping: string
  /** The unit below the model's folder: `5. Sextings/19.10.26`, an archive, a root. */
  unit: string
  files: readonly DoubtFile[]
}

/**
 * Types the import makes of a folder by its section. A FYP and a custom clip are an object by
 * themselves, raw material and promo are no catalog object of a shoot: not asked. Life is many
 * days by nature (a trip, a cat over a year): asked only by the words of a copy.
 */
const ASKED = new Set(['SET', 'SXT', 'PPV', 'CUS', 'LIFE'])
/** A folder named by a date alone (`19.10.26`, `9.10.26`, `05-07.06.26`): what came that day. */
const DAY_FOLDER = /^\d{1,2}(?:-\d{1,2})?\.\d{1,2}\.(?:\d{2}|\d{4})$/u
/** Words of a copy or a collection in a folder name: not one shoot. */
const COPY_WORDS =
  /(?<![\p{L}\p{N}])(архив\p{L}*|archive|с\s+(?:мака|макбука|компа|компьютера|ноута|ноутбука|телефона|айфона)|копи[яи]|бэкап\p{L}*|backup|старые|старое|разное|сборник\p{L}*|не\s*разобран\p{L}*|неразобран\p{L}*)(?![\p{L}\p{N}])/iu
/** A sexting pack is clips with photos: fewer clips than a tenth of its files is a photo set. */
const SEXTING_VIDEO_SHARE = 0.1
/** Photos of one shoot: the first and the last day no more than two days apart. */
const SHOOT_DAYS = 2

const DAY_MS = 86_400_000

function dayWords(iso: string): string {
  const [year, month, day] = iso.split('-')
  return `${day}.${month}.${year}`
}

/** Why the import does not accept the group by itself, or `null`: nothing against its type. */
export function doubtOf(input: DoubtInput): Doubt | null {
  if (!input.type || !ASKED.has(input.type)) return null
  // A day of Life is one life: its folder of a day and its files of a day in the section are one.
  const byDay = input.type !== 'LIFE'
  // Files right in a section, gathered by a day or an upload window: a guess of the boundaries.
  if (input.grouping === 'exif_day' || input.grouping === 'upload_cluster') {
    return byDay
      ? { kind: 'loose_files', text: 'Файлы прямо в разделе — одна ли это съёмка?' }
      : null
  }
  // A clip by itself or a group a person made: its boundaries are known.
  if (input.grouping !== 'folder') return null
  const folders = input.unit.split('/').slice(1)
  if (byDay && DAY_FOLDER.test((folders.at(-1) ?? '').trim())) {
    return { kind: 'day_folder', text: 'Папка дня без названия — одна ли это съёмка?' }
  }
  for (const folder of folders) {
    const word = COPY_WORDS.exec(folder.normalize('NFC'))?.[1]
    if (word) {
      return {
        kind: 'copy_or_collection',
        text: `«${word.toLowerCase()}» в имени — копия или сборник?`,
      }
    }
  }
  const videos = input.files.filter((file) => file.video).length
  if (input.type === 'SXT' && videos < input.files.length * SEXTING_VIDEO_SHARE) {
    return {
      kind: 'photos_only',
      text:
        videos === 0
          ? 'Только фото — это сет?'
          : `Видео ${videos} из ${input.files.length} — это сет?`,
    }
  }
  if (input.type === 'PPV' && videos === 0) {
    return { kind: 'no_video', text: 'Нет видео — это PPV?' }
  }
  // The day of a clip is often the day of its edit (a teaser cut later): photos only.
  if (input.type === 'SET' || input.type === 'SXT') {
    const days = [
      ...new Set(
        input.files.flatMap((file) => (!file.video && file.shotDay ? [file.shotDay] : [])),
      ),
    ].sort()
    const first = days[0]
    const last = days.at(-1)
    if (first && last && Date.parse(last) - Date.parse(first) > SHOOT_DAYS * DAY_MS) {
      return {
        kind: 'several_shoots',
        text: `Несколько съёмок: ${dayWords(first)}–${dayWords(last)}`,
      }
    }
  }
  return null
}

/**
 * The question for a unit of the dry run, as the import will ask it when its files are ready:
 * the days of shooting from the snapshot (the source's EXIF). A numbered unit is not asked.
 */
export function doubtOfUnit(unit: LegacyUnit, timezone: string): Doubt | null {
  if (unit.number) return null
  return doubtOf({
    type: unit.type,
    grouping: unit.grouping,
    unit: unit.path,
    files: unit.files.map((file) => {
      const name = file.relative.slice(file.relative.lastIndexOf('/') + 1)
      return {
        name,
        video: mediaKindOf(name, file.mediaType ?? null) === 'video',
        shotDay: file.shotAt ? localDay(file.shotAt, timezone) : null,
      }
    }),
  })
}

interface DoubtGroup {
  id: string
  grouping: string
  proposed_type: string | null
  evidence: { legacy?: { unit: string } } | null
}

/** The files of a group as the rules see them: media kind and the day of shooting. */
export async function doubtOfGroup(
  tx: Tx,
  modelId: string,
  group: DoubtGroup,
): Promise<Doubt | null> {
  if (!group.proposed_type || !ASKED.has(group.proposed_type) || !group.evidence?.legacy) {
    return null
  }
  const { rows } = await tx.execute<{ path: string | null; video: boolean; day: string | null }>(
    sql`
    WITH model AS (SELECT timezone AS tz FROM models WHERE id = ${modelId}::uuid)
    SELECT d.path,
           coalesce(b.media_kind, CASE
             WHEN d.path ~* '\\.(mp4|mov|m4v|avi|mkv|webm|mts|m2ts|3gp|hevc)$' THEN 'video'
             ELSE 'image' END) = 'video' AS video,
           coalesce(
             (SELECT min(coalesce(p.shot_at_local, p.shot_at AT TIME ZONE m.tz))::date
                FROM blob_probes p
               WHERE p.sha256 IN (d.source_blob_sha256, d.source_sha256, d.master_sha256)
                 AND coalesce(p.shot_at_local, p.shot_at AT TIME ZONE m.tz)
                     BETWEEN timestamp '2015-01-01' AND (now() AT TIME ZONE m.tz) + interval '1 day'),
             (SELECT (r.remote_shot_at AT TIME ZONE m.tz)::date FROM source_revisions r
               WHERE r.model_id = d.model_id AND r.id = d.source_revision_id
                 AND r.remote_shot_at BETWEEN timestamptz '2015-01-01' AND now() + interval '1 day')
           )::text AS day
      FROM inbox_drafts d
      CROSS JOIN model m
      LEFT JOIN blobs b ON b.sha256 = d.source_blob_sha256
     WHERE d.model_id = ${modelId}::uuid AND d.group_id = ${group.id}::uuid
       AND d.state <> 'resolved'`,
  )
  return doubtOf({
    type: group.proposed_type,
    grouping: group.grouping,
    unit: group.evidence.legacy.unit,
    files: rows.map((row) => ({
      name: (row.path ?? '').slice((row.path ?? '').lastIndexOf('/') + 1),
      video: row.video,
      shotDay: row.day,
    })),
  })
}

/**
 * The group waits for a person: ◆ «Что это?» on its files (`needs_type`), the question kept on
 * the group (`evidence.doubt`). The import asks once: a person's answer — the type, a split,
 * a merge — is not asked again.
 */
export async function askAboutGroup(tx: Tx, modelId: string, groupId: string, doubt: Doubt) {
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = 'needs_type', updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND group_id = ${groupId}::uuid AND state <> 'resolved'
       AND blocked_reason IS NULL`)
  const reason = `doubt:${doubt.kind}`
  await tx.execute(sql`
    UPDATE inbox_groups
       SET evidence = coalesce(evidence, '{}'::jsonb)
             || jsonb_build_object('doubt', ${JSON.stringify(doubt)}::jsonb, 'queue', ${reason}::text),
           updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${groupId}::uuid`)
  return { kind: 'queue' as const, reason }
}
