import type { IntegrationLine, IntegrationView } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { spaceAlerts } from './space-alerts'

const NOW = '2026-09-22T11:20:00Z'

function line(id: string, text: string): IntegrationLine {
  return {
    integration_id: id,
    state: 'down',
    icon: 'cloud-off',
    tone: 'attention',
    text,
    owner_action: null,
  }
}

function integration(id: string, model: string | null, account: string | null): IntegrationView {
  return {
    id,
    kind: 'hub',
    model,
    account,
    state: 'down',
    last_ok_at: null,
    since: NOW,
    retry_at: null,
    down_reason: 'unreachable',
    catch_up: null,
    switches: {},
    line: line(id, ''),
  }
}

describe('карточка места', () => {
  const integrations = [
    integration('hub:lora-of', 'lora', 'lora-of'),
    integration('ydisk:ari', 'ari', null),
    integration('ai', null, null),
  ]
  const alerts = [
    line('hub:lora-of', 'Hub недоступен для OF Free с 13:52'),
    line('ydisk:ari', 'Я.Диск Ари недоступен'),
    line('ai', 'Разметка ИИ догоняет'),
  ]

  it('беда страницы Лоры видна только у Лоры, общая — у всех', () => {
    expect(
      spaceAlerts(alerts, integrations, NOW, 'lora').map((entry) => entry.integration_id),
    ).toEqual(['hub:lora-of', 'ai'])
    expect(
      spaceAlerts(alerts, integrations, NOW, 'lily').map((entry) => entry.integration_id),
    ).toEqual(['ai'])
  })

  it('пока интеграции не пришли, чужое не показывается', () => {
    expect(spaceAlerts(alerts, undefined, NOW, 'lily')).toEqual([])
  })
})
