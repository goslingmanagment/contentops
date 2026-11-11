import { describe, expect, it } from 'vitest'
import { type AgentSendRow, agentDraftRefusal, agentSendRefusal } from './publish-rules'

/**
 * What an agent may send (decision of the owner 11.11.2026; SPEC §7, §11.1): free posts of a
 * week the owner approved — the same answer for the route, the work and the views.
 */

/** A FYP on Fansly the owner approved, its draft prepared from that version, Hub silent. */
const ready: AgentSendRow = {
  platform: 'fansly',
  surface: 'fyp',
  item_type: 'FYP',
  price_mills: null,
  release_id: null,
  row_version: 4,
  approved_version: 4,
  hub_status: 'draft',
  hub_sent_at: null,
  hub_prepared_version: 4,
  hub_checks: { blocked: false, findings: [] },
}

describe('agentSendRefusal', () => {
  it('lets an agent send free posts: FYP, a set or a life on the wall, a vault album', () => {
    expect(agentSendRefusal(ready)).toBeNull()
    for (const item_type of ['SET', 'LIFE'] as const) {
      expect(agentSendRefusal({ ...ready, surface: 'wall', item_type })).toBeNull()
      expect(
        agentSendRefusal({ ...ready, surface: 'wall', item_type, price_mills: '0' }),
      ).toBeNull()
    }
    for (const item_type of ['PPV', 'SXT', 'LIFE'] as const) {
      expect(agentSendRefusal({ ...ready, surface: 'vault', item_type })).toBeNull()
    }
  })

  it('never a paid post, a PPV on the wall even without a price, a story, a mass message', () => {
    expect(
      agentSendRefusal({ ...ready, surface: 'wall', item_type: 'SET', price_mills: '9000' }),
    ).toBe('paid')
    expect(agentSendRefusal({ ...ready, surface: 'wall', item_type: 'PPV' })).toBe('paid')
    expect(
      agentSendRefusal({ ...ready, surface: 'vault', item_type: 'PPV', price_mills: '1' }),
    ).toBe('paid')
    expect(agentSendRefusal({ ...ready, surface: 'story', item_type: 'PPV' })).toBe('kind')
    expect(agentSendRefusal({ ...ready, surface: 'mass_dm', item_type: 'PPV' })).toBe('kind')
    // OnlyFans has no FYP or vault through Hub.
    expect(agentSendRefusal({ ...ready, platform: 'onlyfans' })).toBe('kind')
    expect(agentSendRefusal({ ...ready, release_id: 'release-1', surface: 'vault' })).toBe(
      'release',
    )
  })

  it('wants the version the owner approved, once', () => {
    expect(agentSendRefusal({ ...ready, approved_version: null })).toBe('not_approved')
    expect(agentSendRefusal({ ...ready, row_version: 5 })).toBe('changed')
    // A send cleared the stamp: the row needs the owner again.
    expect(
      agentSendRefusal({
        ...ready,
        approved_version: null,
        hub_status: 'approved',
        hub_sent_at: '2026-11-11T10:00:00Z',
      }),
    ).toBe('spent')
  })

  it('wants the draft prepared from that version and nothing found by Hub', () => {
    expect(agentSendRefusal({ ...ready, hub_prepared_version: 3 })).toBe('changed')
    // Edited in Hub after «Подготовить» (the status poll marks it).
    expect(
      agentSendRefusal({ ...ready, hub_checks: { blocked: false, findings: [], edited: true } }),
    ).toBe('changed')
    expect(
      agentSendRefusal({
        ...ready,
        hub_checks: {
          blocked: false,
          findings: [{ code: 'media_recently_posted', severity: 'warning', media_key: null }],
        },
      }),
    ).toBe('hub_findings')
    expect(agentSendRefusal({ ...ready, hub_checks: { blocked: true, findings: [] } })).toBe(
      'hub_findings',
    )
    // Nothing to send yet: the ordinary rules of «Отправить» answer.
    expect(agentSendRefusal({ ...ready, hub_status: null, hub_prepared_version: null })).toBeNull()
  })
})

describe('agentDraftRefusal', () => {
  const draft = (kind: string, raw: Record<string, unknown> = {}) => ({ kind, raw })

  it('passes the free post ContentOps prepared', () => {
    expect(
      agentDraftRefusal('subscriber_post', draft('subscriber_post', { priceMills: null })),
    ).toBeNull()
    expect(agentDraftRefusal('fyp_post', draft('fyp_post'))).toBeNull()
  })

  it('refuses a draft Hub made paid or of another kind', () => {
    expect(agentDraftRefusal('subscriber_post', draft('paid_post'))).toBe('paid')
    expect(
      agentDraftRefusal('subscriber_post', draft('subscriber_post', { priceMills: 9000 })),
    ).toBe('paid')
    expect(agentDraftRefusal('subscriber_post', draft('story'))).toBe('kind')
    expect(agentDraftRefusal('subscriber_post', draft('fyp_post'))).toBe('changed')
  })
})
