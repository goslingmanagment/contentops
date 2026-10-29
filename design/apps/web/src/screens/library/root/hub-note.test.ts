import type { Account, IntegrationView } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { hubFolderNoteText } from './hub-note'

const accounts = [
  { code: 'lora-1', label: 'Fansly 1' },
  { code: 'lora-5', label: 'OF Free' },
] as Account[]

function hub(account: string, patch: Partial<IntegrationView>): IntegrationView {
  return {
    id: `hub:${account}`,
    kind: 'hub',
    model: 'lora',
    account,
    state: 'working',
    last_ok_at: null,
    since: null,
    retry_at: null,
    down_reason: null,
    catch_up: null,
    ...patch,
  } as IntegrationView
}

const line = (id: string) => ({
  integration_id: id,
  state: 'down' as const,
  icon: 'cloud-off' as const,
  tone: 'attention' as const,
  text: 'Hub недоступен для OF Free с 13:52 · повтор через 8 мин',
  owner_action: 'Подробнее' as const,
})

describe('строка Hub на папке «Ещё не залито» (DESIGN §4.1)', () => {
  it('одна страница недоступна — «Hub: OF Free с 13:52»', () => {
    const integrations = [
      hub('lora-1', {}),
      hub('lora-5', { state: 'down', since: '2026-09-22T10:52:00Z' }),
    ]
    expect(hubFolderNoteText(line('hub:lora-5'), integrations, accounts)).toBe(
      'Hub: OF Free с 13:52',
    )
  })

  it('все страницы в одном состоянии — без страницы', () => {
    const integrations = [hub('lora-1', { state: 'off' }), hub('lora-5', { state: 'off' })]
    expect(hubFolderNoteText(line('hub:lora-5'), integrations, accounts)).toBe('Hub выключен')
  })
})
