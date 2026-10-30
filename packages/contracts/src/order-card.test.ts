import { describe, expect, it } from 'vitest'
import type { Account, Platform } from './domain/model'
import { orderTitleOf, parseOrderCard } from './order-card'

/** «Новый заказ» (DESIGN §4.16): what the card text turns into. */

const page = (code: string, label: string, platform: Platform, position: number): Account => ({
  code,
  model: 'lora',
  platform,
  label,
  handle: code,
  hub_page: code,
  usual_assignee: null,
  uniq_level: 'soft',
  position,
})

/** Pages of Лора (DESIGN §9.2), in their order. */
const LORA_PAGES = [
  page('lora-1', 'Fansly 1', 'fansly', 0),
  page('lora-2', 'Fansly 2', 'fansly', 1),
  page('lora-3', 'Fansly 3', 'fansly', 2),
  page('lora-vip-of', 'OF VIP', 'onlyfans', 3),
  page('lora-of', 'OF Free', 'onlyfans', 4),
]

const parse = (text: string) => parseOrderCard(text, null, 2026, LORA_PAGES)

describe('parseOrderCard', () => {
  it('reads the page the card names', () => {
    expect(parse('📌 Кастом «танец»\n👤 фан №4471 · Fansly 2').account).toBe('lora-2')
    expect(parse('фан №10 · фансли 3').account).toBe('lora-3')
    expect(parse('фан №10 · OF VIP · 15 минут').account).toBe('lora-vip-of')
    expect(parse('фан №10, онлифанс фри').account).toBe('lora-of')
  })

  it('takes the first page when the card does not say', () => {
    expect(parse('📌 Кастом «вся в красном»\n⏱ 12-15 минут').account).toBe('lora-1')
  })

  it('does not mistake a longer number for a page', () => {
    expect(parse('Fansly 21 · фан №3').account).toBe('lora-1')
  })

  it('reads the rest of the card', () => {
    const fields = parse(
      '📌 Кастом «в белом халате»\n👤 фан №2201\n📄 медленно у окна\n⏱ 8-10 минут\n🖼 15 фото\n📅 до 30.09',
    )
    expect(fields).toMatchObject({
      buyer: 'фан №2201',
      brief: '«в белом халате» медленно у окна',
      duration_raw: '8-10 минут',
      wants_photos: 15,
      deadline: '2026-09-30',
    })
    expect(orderTitleOf(fields.brief ?? '')).toBe('в белом халате')
  })

  it('names the order by the brief', () => {
    expect(orderTitleOf('в чёрном спорт\nбез музыки')).toBe('в чёрном спорт')
    const long = orderTitleOf(`${'очень длинное ТЗ '.repeat(8)}конец`)
    expect(long.length).toBeLessThanOrEqual(61)
    expect(long.endsWith('…')).toBe(true)
  })
})
