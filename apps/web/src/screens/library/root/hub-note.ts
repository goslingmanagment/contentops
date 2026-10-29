import {
  type Account,
  formatClock,
  type IntegrationLine,
  type IntegrationView,
} from '@contentops/contracts'

/**
 * Короткая строка Hub для третьей строки папки «Ещё не залито» (DESIGN §4.1, §3.11):
 * в папку шириной 200 полная фраза «Hub недоступен для OF Free с 13:52 · повтор через
 * 8 мин» не помещается — на папке «Hub: OF Free с 13:52», полная фраза в подсказке.
 */
export function hubFolderNoteText(
  line: IntegrationLine,
  integrations: readonly IntegrationView[],
  accounts: readonly Account[],
): string {
  const worst = integrations.find((integration) => integration.id === line.integration_id)
  if (!worst) {
    return line.text
  }
  const hub = integrations.filter(
    (integration) => integration.kind === 'hub' && integration.model === worst.model,
  )
  // Та же развилка, что у фразы: все страницы в одном состоянии — без страницы.
  const everyPageAlike = hub.every((integration) => integration.state === worst.state)
  const page = everyPageAlike
    ? null
    : (accounts.find((account) => account.code === worst.account)?.label ?? null)
  const subject = page ? `Hub: ${page}` : 'Hub'
  switch (worst.state) {
    case 'down':
      return worst.since
        ? `${subject}${page ? '' : ' недоступен'} с ${formatClock(worst.since)}`
        : `${subject} недоступен`
    case 'off':
      return `${subject} выключен`
    case 'unset':
      return `${subject} не настроен`
    case 'catching_up':
      return `${subject} догоняет`
    case 'working':
      return line.text
  }
}
