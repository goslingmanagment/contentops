import { describe, expect, it } from 'vitest'
import {
  briefWords,
  buyerNames,
  type CustomFacts,
  candidatesOf,
  decide,
  headSeconds,
  type OrderFacts,
  sameLine,
  skeleton,
} from './customs-match'

/**
 * The rule that links an old custom to its order (SPEC §6.3, §8.2). A wrong link puts one fan's
 * video under another's order, so every case where evidence of identity is missing or shared
 * must end in a question or in no order at all. Names here are invented.
 */

const custom = (name: string, extra: Partial<CustomFacts> = {}): CustomFacts => ({
  name,
  durationS: headSeconds(name),
  at: '2026-03-10T12:00:00Z',
  video: true,
  photos: 0,
  ...extra,
})

const order = (id: string, extra: Partial<OrderFacts> = {}): OrderFacts => ({
  id,
  buyer: null,
  brief: 'Танец у окна',
  cardText: null,
  cardAt: '2026-03-01T10:00:00Z',
  minS: 240,
  durationRaw: '5 минут',
  wantsVideo: true,
  wantsPhotos: 0,
  lines: [],
  ...extra,
})

describe('names', () => {
  it('reads a time at the start in any spelling of the copy', () => {
    expect(headSeconds('12:40 гимнастика')).toBe(760)
    expect(headSeconds('12-40 гимнастика ')).toBe(760)
    expect(headSeconds('без времени')).toBeNull()
  })

  it('reduces a name in either alphabet to the same letters', () => {
    expect(skeleton('Глеб')).toBe(skeleton('Gleb'))
    expect(skeleton('Джордан')).toBe(skeleton('Jordan'))
    expect(skeleton('Рекс')).toBe(skeleton('Rex'))
    expect(skeleton('Орион')).not.toBe(skeleton('Ориана'))
  })

  it('takes the buyer from the field, the nick of the link and «Имя:» of the card', () => {
    const names = buyerNames({
      buyer: 'https://fansly.com/orionfan77/posts',
      cardText: 'Покупатель: https://onlyfans.com/u123456\nИмя: Liam\nОплата: 50$',
    })
    expect(names).toContain(skeleton('orionfan77'))
    expect(names).toContain(skeleton('Liam'))
    expect(names.some((name) => /fansly|posts|u123456/.test(name))).toBe(false)
  })

  it('a line is the name, or begins with it and goes on with a note', () => {
    expect(sameLine('12:40 гимнастика', '12:40 гимнастика')).toBe(true)
    expect(sameLine('8:02 вечер', '8:02 вечер Имя 2:50, 5:20')).toBe(true)
    expect(sameLine('8:02 веч', '8:02 вечер')).toBe(false)
    // A message of several lines, the name after «назвала —», a time at the end, no time.
    expect(sameLine('7:05 в саду', '4:10 зарядка\n\n7:05 в саду')).toBe(true)
    expect(sameLine('6:15 в синем', 'Загрузила на диск, назвала - 6:15 в синем')).toBe(true)
    expect(sameLine('танец 4:50', 'Загрузила на диск, папка кастом, назвала - танец 4:50')).toBe(
      true,
    )
    expect(sameLine('Зарядка и душ', 'Загрузила на диск, назвала- Зарядка и душ')).toBe(true)
    // One word without a time is too common to stand for one file.
    expect(sameLine('зарядка', 'зарядка')).toBe(false)
  })

  it('finds words of the name in the brief by their stem, at least half of them', () => {
    expect(briefWords('5:00 вся в зелёном', 'Платье зелёное, медленно')).toEqual(['зеленом'])
    expect(briefWords('14:05 библиотекарь шпагат', '**ШПАГАТ** у стены')).toEqual(['шпагат'])
    expect(briefWords('10:00 пальцы', 'Пальто и сапоги')).toEqual([])
    expect(briefWords('7:00 кастом', 'Кастом для фана')).toEqual([])
  })
})

describe('what rules an order out', () => {
  it('a custom shorter than ordered by more than 10 %; longer is fine', () => {
    const tenMinutes = order('a', { buyer: 'Felix', minS: 540, durationRaw: '10 минут' })
    expect(candidatesOf(custom('8:00 Феликс'), [tenMinutes])).toEqual([])
    expect(candidatesOf(custom('8:40 Феликс'), [tenMinutes])).toHaveLength(1)
    expect(candidatesOf(custom('25:00 Феликс'), [tenMinutes])).toHaveLength(1)
  })

  it('a file uploaded before the card was posted', () => {
    const card = order('a', { buyer: 'Felix', cardAt: '2026-03-20T10:00:00Z' })
    expect(candidatesOf(custom('6:00 Феликс'), [card])).toEqual([])
  })

  it('a part the order does not want', () => {
    const photos = order('a', { buyer: 'Felix', wantsVideo: false, wantsPhotos: 20, minS: null })
    expect(candidatesOf(custom('6:00 Феликс'), [photos])).toEqual([])
    const folder = custom('Феликс 20 фото', { video: false, photos: 20, durationS: null })
    expect(candidatesOf(folder, [order('b', { buyer: 'Felix' })])).toEqual([])
    expect(candidatesOf(folder, [photos])).toHaveLength(1)
  })
})

describe('the decision', () => {
  it('the model line under one card links, with the line as evidence', () => {
    const lined = order('a', { lines: [{ text: '12:40 гимнастика', ref: 'tg:-100/3/101' }] })
    const decision = decide(custom('12:40 гимнастика'), [lined, order('b')], [])
    expect(decision.kind).toBe('link')
    if (decision.kind !== 'link') return
    expect(decision.candidate.order.id).toBe('a')
    expect(decision.candidate.evidence).toEqual(['tg:-100/3/101'])
    expect(decision.candidate.signals[0]).toBe('строка модели «12:40 гимнастика»')
  })

  it('two files of one name under one line are a question, two lines of one order link', () => {
    const lined = order('a', {
      lines: [
        { text: '4:10 зарядка\n\n7:05 в саду', ref: 'tg:-100/3/1' },
        { text: '12:40 гимнастика', ref: 'tg:-100/3/2' },
      ],
    })
    const first = custom('12:40 гимнастика')
    const again = custom('12:40 гимнастика', { at: '2026-05-01T12:00:00Z' })
    expect(decide(first, [lined], [first, again]).kind).toBe('ask')
    const dance = custom('4:10 зарядка')
    const garden = custom('7:05 в саду')
    expect(decide(dance, [lined], [dance, garden]).kind).toBe('link')
    expect(decide(garden, [lined], [dance, garden]).kind).toBe('link')
  })

  it('a line that two orders carry is a question', () => {
    const line = { text: '5:00 тизер', ref: 'tg:-100/3/1' }
    const decision = decide(
      custom('5:00 тизер'),
      [order('a', { lines: [line] }), order('b', { lines: [{ ...line, ref: 'tg:-100/3/2' }] })],
      [],
    )
    expect(decision.kind).toBe('ask')
  })

  it('a line of one order and the brief of another — a question, not a link', () => {
    // One file delivered for one order, while the brief of another order has its words.
    const lined = order('a', { lines: [{ text: '12:40 гимнастика', ref: 'tg:-100/3/101' }] })
    const other = order('b', { brief: '**ГИМНАСТИКА** на ковре' })
    expect(decide(custom('12:40 гимнастика'), [lined, other], []).kind).toBe('ask')
  })

  it('the buyer in the name links when no other custom names him', () => {
    const felix = order('a', { buyer: 'https://fansly.com/felix_rw/posts', cardText: 'Имя: Felix' })
    const decision = decide(custom('9:10 Феликс'), [felix, order('b')], [custom('7:00 в душе')])
    expect(decision).toMatchObject({ kind: 'link', candidate: { identity: 'buyer' } })
  })

  it('two customs naming the same buyer — both are questions', () => {
    const felix = order('a', { buyer: 'Felix' })
    const first = custom('9:10 Феликс')
    const second = custom('6:30 Феликс душ')
    expect(decide(first, [felix], [first, second]).kind).toBe('ask')
    expect(decide(second, [felix], [first, second]).kind).toBe('ask')
  })

  it('two orders of the same buyer — a question', () => {
    const decision = decide(
      custom('9:10 Феликс'),
      [order('a', { buyer: 'Felix' }), order('b', { buyer: 'Felix' })],
      [],
    )
    expect(decision).toMatchObject({ kind: 'ask', candidates: [{}, {}] })
  })

  it('words of the brief alone never link', () => {
    const green = order('a', { brief: 'Вся в зелёном у окна' })
    expect(decide(custom('5:00 вся в зелёном'), [green], []).kind).toBe('ask')
  })

  it('duration and date alone make no candidate at all', () => {
    expect(decide(custom('5:10 у стены'), [order('a')], [])).toEqual({ kind: 'none' })
  })

  it('the candidates carry what matched in words', () => {
    const green = order('a', { brief: 'Зелёное платье' })
    const [candidate] = candidatesOf(custom('5:00 вся в зелёном'), [green])
    expect(candidate?.signals).toEqual([
      'в ТЗ: «зеленом»',
      '5:00 при заказанных «5 минут»',
      'через 9 дн. после карточки',
    ])
  })

  it('a custom of an order folder answers to its other names: the reply line of the model links', () => {
    // `05.10.26 fanfox кресло/IMG_7002.MOV` — the model replied to the card with that file.
    const reply = { text: 'IMG_7002.MOV', ref: 'tg:3/128/1733' }
    const chair = order('a', { buyer: 'fanfox', lines: [reply] })
    const other = order('b', { buyer: 'someone' })
    const folder = custom('05.10.26 fanfox кресло', { alsoNamed: ['IMG_7002', '1724'] })
    expect(decide(folder, [chair, other], [])).toMatchObject({
      kind: 'link',
      candidate: { order: { id: 'a' }, identity: 'line', evidence: ['tg:3/128/1733'] },
    })
    // A clip called by its order folder too: the buyer.
    const clip = custom('IMG_7003', { alsoNamed: ['10.10.26 owlbear спорт и ванна'] })
    expect(decide(clip, [order('c', { buyer: 'owlbear' })], [])).toMatchObject({
      kind: 'link',
      candidate: { identity: 'buyer' },
    })
    // Without other names nothing changes: the file's name alone says nothing here.
    expect(decide(custom('IMG_7003'), [order('c', { buyer: 'owlbear' })], [])).toEqual({
      kind: 'none',
    })
  })

  it('«папка X» of the model names the folder of the answer', () => {
    // Лора, 25.10.2026, a reply to the card «видео из 4 этапов».
    const reply = { text: 'Папка кастом>папка 4 видео', ref: 'tg:3/9993' }
    const stages = order('a', { brief: 'Видео из 4 этапов', lines: [reply] })
    expect(decide(custom('4 Видео'), [stages], [])).toMatchObject({
      kind: 'link',
      candidate: { identity: 'line', evidence: ['tg:3/9993'] },
    })
    expect(sameLine('38 фото', 'Загрузила в папку 38 фото')).toBe(true)
    // One word after «папка» names nothing of its own.
    expect(sameLine('бг', 'Загрузила в папку бг')).toBe(false)
  })

  it('a reply line does not outweigh a second candidate: two orders of one buyer ask', () => {
    const reply = { text: 'IMG_9527.MOV', ref: 'tg:3/128/1384' }
    const first = order('a', { buyer: 'boxer', lines: [reply] })
    const second = order('b', { buyer: 'boxer' })
    const folder = custom('[CUS-003]_pov_3min_boxer_16.09.26', { alsoNamed: ['IMG_9527'] })
    expect(decide(folder, [first, second], [])).toMatchObject({ kind: 'ask' })
  })
})
