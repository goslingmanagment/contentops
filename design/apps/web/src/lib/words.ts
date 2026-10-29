import { type Account, type CatalogEntry, formatNumber, plural } from '@contentops/contracts'

/**
 * Общие слова экранов: одна запись на всё приложение, чтобы «Fansly 2» и «3 файла» не
 * расходились между Планом, Заказами и Промо.
 */

/** Страница модели по коду; `undefined`, если у модели такой нет. */
export function accountOf(accounts: readonly Account[], code: string): Account | undefined {
  return accounts.find((account) => account.code === code)
}

/** «Fansly 2»; незнакомый код — как есть. */
export function accountLabel(accounts: readonly Account[], code: string): string {
  return accountOf(accounts, code)?.label ?? code
}

/** «1 файл», «3 файла». */
export function filesWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['файл', 'файла', 'файлов'])}`
}

/**
 * Состав без длительности: «10 фото · 12 видео», «63 фото», «12 видео»; `null` — ни того,
 * ни другого. «N фото» — только у объектов из одних фото: иначе подпись прятала бы видео.
 */
export function compositionText(
  entry: Pick<CatalogEntry, 'photo_count' | 'video_count'>,
): string | null {
  const photos = entry.photo_count ?? 0
  const videos = entry.video_count ?? 0
  const parts = [
    photos > 0 ? `${formatNumber(photos)} фото` : null,
    videos > 0 ? `${formatNumber(videos)} видео` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** То же на обложке, где места мало: у смешанного — «22 файла». */
export function compositionLabel(
  entry: Pick<CatalogEntry, 'photo_count' | 'video_count'>,
): string | undefined {
  const photos = entry.photo_count ?? 0
  const videos = entry.video_count ?? 0
  if (photos > 0 && videos > 0) {
    return filesWord(photos + videos)
  }
  return compositionText(entry) ?? undefined
}
