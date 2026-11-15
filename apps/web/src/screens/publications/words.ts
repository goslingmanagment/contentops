import type { StatusKind } from '@contentops/ui/components/status-sign'

/**
 * Слова «Публикаций» — те же, что у экрана Hub (`packages/ui/src/console/statusWords.ts` в Hub): одна вещь одним
 * словом во всех продуктах.
 */
export const STATUS_WORDS: Readonly<Record<string, { word: string; sign?: StatusKind }>> = {
  draft: { word: 'Ждёт утверждения', sign: 'turn' },
  approved: { word: 'Утверждён' },
  submitting: { word: 'Ставится' },
  scheduled: { word: 'В расписании' },
  processing: { word: 'Обрабатывается' },
  published: { word: 'Вышел', sign: 'done' },
  unknown: { word: 'Исход неизвестен', sign: 'trouble' },
  missed: { word: 'Пропущен', sign: 'trouble' },
  not_published: { word: 'Не вышел', sign: 'trouble' },
  rejected: { word: 'Отклонён', sign: 'trouble' },
  withdrawn: { word: 'Убран из расписания' },
  cancelled: { word: 'Отменён' },
}

export function statusWord(
  status: string,
  reason: string | null,
): { word: string; sign?: StatusKind } {
  if (status === 'withdrawn' && reason === 'deleted_after_publish')
    return { word: 'Удалён со стены' }
  return STATUS_WORDS[status] ?? { word: `в Hub: ${status}` }
}

export const KIND_WORDS: Readonly<Record<string, string>> = {
  fyp_post: 'Пост в ленту For You',
  subscriber_post: 'Пост для подписчиков',
  paid_post: 'Платный пост',
  story: 'Сториз',
  vault_album: 'Альбом медиатеки',
}

export const WINDOW_CHOICES = [
  { value: 'next7', label: '7 дней вперёд' },
  { value: 'next30', label: '30 дней вперёд' },
  { value: 'last7', label: 'Последние 7 дней' },
  { value: 'last30', label: 'Последние 30 дней' },
  { value: 'all', label: 'Все даты' },
] as const

/** Срезы ленты, как на экране Hub. */
export const SEGMENTS = [
  { value: 'all', label: 'Все', status: undefined, window: 'next7' },
  { value: 'draft', label: 'Ждут утверждения', status: 'draft', window: 'all' },
  { value: 'unknown', label: 'Исход неизвестен', status: 'unknown', window: 'all' },
  { value: 'not_out', label: 'Не вышли за 7 дней', status: 'not_out', window: 'last7' },
] as const

/** Проверки поста в Hub обычными словами; незнакомую говорим, как её написал Hub. */
const FINDING_WORDS: Readonly<Record<string, string>> = {
  media_not_on_page: 'файла нет в медиатеке страницы',
  wall_default_unknown: 'у страницы не известна стена',
  repost_within_threshold: 'файл уже выходил недавно',
  price_outside_range: 'цена вне вилки страницы',
  price_range_not_set: 'у страницы не задана вилка цен',
  file_deleted: 'файл удалён с сервера, загрузите снова',
  file_of_another_model: 'файл другой модели',
}

export function findingWord(code: string): string {
  return FINDING_WORDS[code] ?? code
}

/** Сумма в миллях долларами: «$19.99». */
export function formatMills(mills: number): string {
  return `$${(mills / 1000).toFixed(2)}`
}

export function filesWord(count: number): string {
  if (count === 0) return 'без файлов'
  const last = count % 10
  const tens = count % 100
  const word =
    last === 1 && tens !== 11
      ? 'файл'
      : last >= 2 && last <= 4 && (tens < 12 || tens > 14)
        ? 'файла'
        : 'файлов'
  return `${count} ${word}`
}

/** Почему экран пуст, словами: у каждой причины своя фраза. */
export function hubStateWords(state: string): string | null {
  switch (state) {
    case 'no_grant':
      return 'Публикации открываются с учётной записью из реестра людей Hub. Попросите владельца.'
    case 'refused':
      return 'Вашей роли публикации не открыты. Попросите владельца.'
    case 'unreachable':
      return 'Hub сейчас не отвечает. Публикации никуда не делись: обновите чуть позже.'
    case 'no_hub':
      return 'Hub не подключён к ContentOps.'
    default:
      return null
  }
}
