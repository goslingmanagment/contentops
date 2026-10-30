import {
  describeIntegration,
  type Instant,
  type IntegrationLine,
  type IntegrationView,
  type ModelCode,
} from '@contentops/contracts'

/** `hub.lora-of` (у заглушки `hub:lora-of`) → `hub`: вид интеграции из её ID. */
function kindOf(line: IntegrationLine): string {
  return line.integration_id.split(/[.:]/)[0] ?? line.integration_id
}

/**
 * Строки карточки места (DESIGN §2.2, §3.11): только «недоступно» и «догоняет», и только
 * общие и текущей модели — беда страницы Лоры у Lily не показывается. Если одна беда у
 * нескольких страниц сразу, остаётся одна строка без страницы — иначе узкая карточка
 * превращается в список.
 */
export function spaceAlerts(
  alerts: readonly IntegrationLine[],
  integrations: readonly IntegrationView[] | undefined,
  now: Instant,
  model: ModelCode | null,
): IntegrationLine[] {
  // «Мало места: 180 ГБ» и «Забор остановлен» — строки места, общие для всех моделей.
  const space = alerts.filter((line) => kindOf(line) === 'space')
  const ours = alerts.filter((line) => {
    const source = integrations?.find((integration) => integration.id === line.integration_id)
    return source !== undefined && (source.model === null || source.model === model)
  })
  const groups = new Map<string, IntegrationLine[]>()
  for (const line of ours) {
    const key = `${kindOf(line)}|${line.state}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  const integrationLines = [...groups.values()].flatMap((lines) => {
    const first = lines[0]
    if (!first) {
      return []
    }
    if (lines.length === 1) {
      return [first]
    }
    const source = integrations?.find((integration) => integration.id === first.integration_id)
    return [source ? describeIntegration(source, { now, accountLabel: null }) : first]
  })
  return [...space, ...integrationLines]
}
