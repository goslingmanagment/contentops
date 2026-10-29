import type { CatalogEntry, HubPost } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { compareComposition, compositionOf } from './case-text'

function entry(patch: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: 'FYP-0803',
    type: 'fyp',
    title: 'Кружево утром',
    tags: [],
    markup: 'confirmed',
    cover: { key: 'FYP-0803', ratio: '9:16' },
    duration_s: null,
    photo_count: null,
    video_count: null,
    version_count: 1,
    has_teaser: false,
    arrived_on: '2026-09-20',
    shot_on: null,
    ppv_kind: null,
    raw_purpose: null,
    ppv_made_as: null,
    fan_name: null,
    second_person: false,
    delivered_on: null,
    selected_count: null,
    processed_count: null,
    life_unassigned: null,
    life_chat_count: null,
    life_feed_count: null,
    steady_content: false,
    photo_custom: false,
    aliases: [],
    order_id: null,
    channel: null,
    size_bytes: null,
    ...patch,
  }
}

function post(patch: Partial<HubPost>): HubPost {
  return {
    evidence_id: 'e-1',
    post_at: '2026-09-22T08:02:00Z',
    offset_min: null,
    summary: '',
    duration_s: null,
    photo_count: null,
    caption: null,
    platform_file_name: null,
    url: 'https://fansly.com/post/LoraVie/e-1',
    ...patch,
  }
}

describe('наше против поста (DESIGN §4.15)', () => {
  it('разная длительность — «не совпадает» с обеими цифрами', () => {
    expect(
      compareComposition(entry({ duration_s: 10 }), post({ duration_s: 7, photo_count: 0 })),
    ).toEqual({ text: 'видео 0:10 и 0:07 — не совпадает', matches: false })
  })

  it('видео и фото сходятся — состав поста и «совпадает»', () => {
    expect(
      compareComposition(
        entry({ type: 'ppv', duration_s: 581, photo_count: 2 }),
        post({ duration_s: 581, photo_count: 2 }),
      ),
    ).toEqual({ text: 'видео 9:41 и 2 фото — совпадает', matches: true })
  })

  it('у сета сравниваются отобранные кадры, а не весь сет', () => {
    const set = entry({ id: 'SET-072', type: 'set', photo_count: 38, selected_count: 22 })
    expect(compareComposition(set, post({ photo_count: 22 }))).toEqual({
      text: '22 фото — совпадает',
      matches: true,
    })
    expect(compareComposition(set, post({ photo_count: 20 }))).toEqual({
      text: 'фото 22 и 20 — не совпадает',
      matches: false,
    })
    expect(compositionOf(set)).toBe('38 фото, отобрано 22')
  })

  it('Hub не знает состав поста — сравнивать нечего', () => {
    expect(compareComposition(entry({ duration_s: 10 }), post({}))).toBeNull()
  })
})
