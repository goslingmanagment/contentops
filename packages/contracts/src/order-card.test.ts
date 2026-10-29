import { describe, expect, it } from 'vitest'
import { LORA_ACCOUNTS } from './fixtures/models'
import { parseOrderCard } from './order-card'

/** «Новый заказ» (DESIGN §4.16): what the card text turns into. */

const parse = (text: string) => parseOrderCard(text, null, 2026, LORA_ACCOUNTS)

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
      title: 'в белом халате',
      buyer: 'фан №2201',
      brief: 'медленно у окна',
      duration_raw: '8-10 минут',
      wants_photos: 15,
      deadline: '2026-09-30',
    })
  })
})
