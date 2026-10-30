import { formatAgo, type Instant, type IntegrationView } from '@contentops/contracts'
import { useClock } from '@/data/api-session'
import { useIntegrations } from '@/data/integrations'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'

/**
 * Скан облака этой модели, если он не работает (DESIGN §3.11). Ненастроенное второе облако
 * не беда, пока первое работает: у Лоры новое идёт в Dropbox, Я.Диск — архив.
 */
export function useDiskTrouble(model: string): IntegrationView | null {
  const integrations = useIntegrations().data ?? []
  const clouds = integrations.filter(
    (integration) =>
      (integration.kind === 'ydisk' || integration.kind === 'dropbox') &&
      (integration.model === model || integration.model === null),
  )
  const working = clouds.some((integration) => integration.state === 'working')
  return (
    clouds.find(
      (integration) =>
        integration.state !== 'working' && !(working && integration.state === 'unset'),
    ) ?? null
  )
}

/** «Я.Диск проверен 4 мин назад» — по пустому тексту видно, что всё разобрано. */
export function diskCheckedText(checkedAt: Instant | null, now: Instant): string | null {
  return checkedAt ? `Я.Диск проверен ${formatAgo(checkedAt, now)}` : null
}

interface DiskLineProps {
  model: string
  checkedAt: Instant | null
}

/**
 * Справа в шапке «Приехало» (DESIGN §4.8): серым «Я.Диск проверен 4 мин назад», а при
 * выключенном скане — строка интеграции «Скан Я.Диска выключен — загрузка работает».
 */
export function DiskLine({ model, checkedAt }: DiskLineProps) {
  const now = useClock().now()
  const trouble = useDiskTrouble(model)
  if (trouble) {
    return <IntegrationPhrase line={trouble.line} withOwnerAction className="max-w-[32rem]" />
  }
  const text = diskCheckedText(checkedAt, now)
  if (!text) {
    return null
  }
  // С открытой панелью места мало: строка не режется, а переносится на две —
  // «Я.Диск проверен» / «4 мин назад»; совсем узко — «Я.Диск» / «4 мин назад».
  // Полная фраза — в подсказке.
  const ago = text.slice('Я.Диск проверен '.length)
  return (
    <span className="@container/disk flex min-w-0 flex-1 justify-end">
      <span title={text} className="line-clamp-2 text-right text-ink-3 text-sm leading-4">
        <span className="@max-[7rem]/disk:hidden">{nbsp('Я.Диск проверен')}</span>
        <span className="hidden @max-[7rem]/disk:inline">Я.Диск</span> {nbsp(ago)}
      </span>
    </span>
  )
}

/** Неразрывные пробелы: часть фразы переносится только целиком. */
function nbsp(text: string): string {
  return text.replaceAll(' ', '\u00a0')
}
