import { describe, expect, it } from 'vitest'
import { createHandlers } from './handlers/index'
import { tableRoutes } from './routes'
import type { Services } from './services'

/**
 * Every route of the table has a handler, except the ones below: each waits for the PLAN
 * stage that owns it and answers 501 until then. A route that loses its handler, or a new
 * route without one, fails here; implementing a listed one means deleting its line.
 */
const NOT_YET: Record<string, string> = {
  // «Сверить» (PLAN 5, DESIGN §4.14): pairs of Hub posts and plan rows — the matching of
  // stage 5, done by its own agent.
  'check.list': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.resolved': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.notOurs': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.unverified': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.get': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.confirmPair': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.reject': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.bind': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.outside': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.undo': 'этап 5 — «Сверить», сопоставление с Hub',
  'check.confirmUnambiguous': 'этап 5 — «Сверить», сопоставление с Hub',
  // AI services and their budget (SPEC §8.3: AI is stage 8).
  'settings.addAiService': 'этап 8 — ИИ',
  'settings.updateAiService': 'этап 8 — ИИ',
  'settings.updateAiBudget': 'этап 8 — ИИ',
  'settings.resumeAi': 'этап 8 — ИИ',
  // The frame sheet of «Разметка на проверку» (DESIGN §4.20 «Места под ИИ»); its record has
  // no table before the annotation migration of 8а (schema §9.5).
  'objects.saveFrameCheck': 'этап 8 — лист кадров, «Места под ИИ»',
}

describe('routes of the table', () => {
  it('are all answered, except those waiting for their stage', () => {
    const handlers = createHandlers({} as Services) as Record<string, Record<string, unknown>>
    const unanswered = tableRoutes()
      .filter(({ area, name }) => !handlers[area]?.[name])
      .map(({ key }) => key)
      .sort()
    expect(unanswered).toEqual(Object.keys(NOT_YET).sort())
  })
})
