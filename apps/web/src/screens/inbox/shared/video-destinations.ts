import type { VideoInSetDestination } from '@contentops/contracts'

/** ◆ «Видео среди фото — куда?» (DESIGN §2.5): в панели и в полосе «Куда видео ▾». */
export const VIDEO_DESTINATIONS: readonly { value: VideoInSetDestination; label: string }[] = [
  { value: 'raw', label: 'В сырьё' },
  { value: 'life', label: 'В лайф' },
  { value: 'fyp_source', label: 'Исходник фупа' },
  { value: 'separate', label: 'Отдельно' },
  { value: 'reject', label: 'Отклонить' },
]

/** Полоска после «Куда видео»: «Видео → сырьё, отдельная группа» (§3.8). */
const DONE: Record<VideoInSetDestination, string> = {
  raw: 'Видео → сырьё',
  life: 'Видео → лайф',
  fyp_source: 'Видео → исходник фупа',
  separate: 'Видео — отдельно',
  reject: 'Видео отклонено',
}

export function videoDoneMessage(destination: VideoInSetDestination, groups: number): string {
  if (destination === 'reject') {
    return DONE.reject
  }
  return `${DONE[destination]}, ${groups === 1 ? 'отдельная группа' : `отдельные группы: ${groups}`}`
}
