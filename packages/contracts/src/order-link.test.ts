import { describe, expect, it } from 'vitest'
import { orderAddress, parseTelegramRef, telegramRefText, telegramUrl } from './order-link'

/** The card is the order's address (SPEC §4.1): every spelling of a link is one card. */
describe('parseTelegramRef', () => {
  const card = { chat: '2627984998', topic: 12, message: 9844 }

  it('reads links, the stored form and the address alike', () => {
    for (const text of [
      'https://t.me/c/2627984998/12/9844',
      't.me/c/2627984998/12/9844?single',
      'tg:2627984998/12/9844',
      'tg:-1002627984998/12/9844',
      'tg-2627984998-12-9844',
    ]) {
      expect(parseTelegramRef(text), text).toEqual(card)
    }
  })

  it('keeps a card without a topic and a public chat', () => {
    expect(parseTelegramRef('https://t.me/c/2627984998/9844')).toEqual({
      chat: '2627984998',
      topic: null,
      message: 9844,
    })
    expect(parseTelegramRef('https://t.me/LoraCustoms/7/55')).toEqual({
      chat: 'loracustoms',
      topic: 7,
      message: 55,
    })
  })

  it('refuses what is not a message link', () => {
    for (const text of ['', 'https://example.com/c/1/2', 'tg:1/2/3/4', 't.me/c/abc/1', 'tg:1/0'])
      expect(parseTelegramRef(text), text).toBeNull()
  })

  it('writes the stored form, the link and the address', () => {
    expect(telegramRefText(card)).toBe('tg:2627984998/12/9844')
    expect(telegramUrl(card)).toBe('https://t.me/c/2627984998/12/9844')
    expect(orderAddress(card)).toBe('tg-2627984998-12-9844')
    expect(orderAddress({ ...card, topic: null })).toBe('tg-2627984998-9844')
  })
})
