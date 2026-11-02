import type { values } from '@contentops/db'

/**
 * What «Принять» refuses by the files of a group (naming §3, schema §5 «Роли нового объекта»).
 * One rule for the accept and for the screen: a group that would be refused says so on its tile
 * before anyone presses the button (DESIGN §4.8).
 */

export interface Refusal {
  /** The reason of `accept_blocked`, as the import of the old corpus queues it. */
  reason: 'video_in_set'
  /** The line under the disabled «Принять». */
  message: string
  /** What a person answers. */
  decision: 'video_in_set' | 'split_videos' | 'what_is_it'
}

const refusal = (message: string, decision: Refusal['decision']): Refusal => ({
  reason: 'video_in_set',
  message,
  decision,
})

/** A new object of `type` from a group of `videos` and `photos`. */
export function newObjectRefusal(
  type: values.ContentType,
  videos: number,
  photos: number,
): Refusal | null {
  switch (type) {
    case 'PPV':
      return videos > 2 ? refusal('Видео больше двух — разделите группу', 'split_videos') : null
    case 'CUS':
      return videos > 1 ? refusal('В кастоме одно видео — разделите группу', 'split_videos') : null
    case 'FYP':
      if (videos === 0) return refusal('Фуп — это ролик: выберите тип', 'what_is_it')
      return videos > 1 || photos > 0
        ? refusal('Фуп — один ролик: разделите группу', 'split_videos')
        : null
    case 'SET':
      return videos > 0 ? refusal('Видео среди фото — решите, куда его', 'video_in_set') : null
    default:
      return null
  }
}

/**
 * Files added to an existing object of `type`: a new file in an accepted folder. A video in an
 * accepted set is the only case discovery can bring; a photo never becomes a revision of a clip.
 */
export function appendRefusal(type: values.ContentType, videos: number): Refusal | null {
  return type === 'SET' && videos > 0 ? refusal('Видео в сет не добавляется', 'video_in_set') : null
}
