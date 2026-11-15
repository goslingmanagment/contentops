import { describe, expect, it } from 'vitest'
import {
  hubEntrySearchSchema,
  hubEntryTarget,
  publicationsSearchOf,
  statsSearchOf,
} from './hub-entry-search'

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

  it("opens the model Hub names (mapped here), says when it is not one of the person's, else the last one", () => {
    const models = ['ari', 'lora', 'smoke']
    const base = { hubModels: { test: 'smoke' }, models, last: 'ari' }
    expect(hubEntryTarget({ ...base, asked: 'Lora' })).toEqual({ kind: 'model', model: 'lora' })
    expect(hubEntryTarget({ ...base, asked: 'test' })).toEqual({ kind: 'model', model: 'smoke' })
    // Hub's Lilly is no model here: said, never Ari's or Lora's posts under her name.
    expect(hubEntryTarget({ ...base, asked: 'Lilly' })).toEqual({ kind: 'missing', asked: 'lilly' })
    expect(hubEntryTarget({ ...base, asked: undefined })).toEqual({ kind: 'model', model: 'ari' })
    expect(hubEntryTarget({ ...base, asked: undefined, last: null })).toEqual({
      kind: 'model',
      model: 'ari',
    })
    expect(hubEntryTarget({ ...base, models: [], asked: undefined })).toEqual({ kind: 'none' })
  })
})
