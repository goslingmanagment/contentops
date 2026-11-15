import { describe, expect, it } from 'vitest'
import { hubEntrySearchSchema, publicationsSearchOf, statsSearchOf } from './hub-entry-search'

describe("Hub's old addresses into ContentOps' screens", () => {
  it('a post of «Публикации» keeps its card, page, status and window', () => {
    const search = hubEntrySearchSchema.parse({
      model: 'test',
      post: 55,
      page: 'test-1',
      status: 'draft',
      window: 'all',
    })
    expect(publicationsSearchOf(search)).toEqual({
      post: 55,
      page: 'test-1',
      status: 'draft',
      window: 'all',
    })
  })

  it('the settings panel and a window ContentOps has not drop nothing else', () => {
    const search = hubEntrySearchSchema.parse({ panel: 'settings', window: 'next90' })
    expect(publicationsSearchOf(search)).toEqual({ panel: 'settings' })
  })

  it('«Статистика» keeps the page, the period and the media card (a long id stays a string)', () => {
    const search = hubEntrySearchSchema.parse({
      page: 'mia-1',
      days: 7,
      media: '851203394123456789',
    })
    expect(statsSearchOf(search)).toEqual({ page: 'mia-1', days: 7, media: '851203394123456789' })
    expect(statsSearchOf(hubEntrySearchSchema.parse({ days: 14 }))).toEqual({})
  })
})
