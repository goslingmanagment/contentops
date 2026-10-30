import { addDays, mskInstant } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { ActorRef, LocalDate } from '@contentops/contracts/domain/common'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import { AGENT, PERSON } from './people'
import { createRandom } from './random'
import type { OrderRecord } from './world-types'

/** Custom orders of Лора (DESIGN §9.7): 7 open, 30 closed; buyers are numbers only. */

const CHAT = 'tg-1002627984998-12'
const DIANA: ActorRef = { type: 'person', id: PERSON.diana, name: 'Диана', gender: 'f' }
const ORDERS_AGENT: ActorRef = {
  type: 'agent',
  id: AGENT.orders,
  name: 'Агент заказов',
  gender: 'm',
}

export const ORDER_ID = {
  red: `${CHAT}-9761`,
  bellyDance: `${CHAT}-9790`,
  lingerie: `${CHAT}-9803`,
  blackSport: `${CHAT}-9877`,
  breastsButt: `${CHAT}-9901`,
  breasts: `${CHAT}-9912`,
  boss: `${CHAT}-9844`,
} as const

function card(message: string, lines: readonly string[]): string {
  return [`📌 Кастом ${message}`, ...lines].join('\n')
}

/** An order from its Telegram card; `messages` are the ones after the card. */
function order(
  id: string,
  patch: Omit<
    OrderRecord,
    'id' | 'card' | 'deliveries' | 'revisions' | 'messages' | 'closed_at' | 'version'
  > &
    Partial<Pick<OrderRecord, 'deliveries' | 'revisions' | 'messages' | 'closed_at'>> & {
      posted_on: LocalDate
      card_lines: readonly string[]
    },
): OrderRecord {
  const postedAt = mskInstant(patch.posted_on, '12:10')
  const { posted_on: _postedOn, card_lines: cardLines, messages = [], ...fields } = patch
  return {
    id,
    card: {
      url: `https://t.me/c/2627984998/${id.split('-').at(-1)}`,
      author: 'Катя (чаттер)',
      posted_at: postedAt,
      text: card(`«${patch.title}»`, cardLines),
    },
    deliveries: [],
    revisions: [],
    // The card opens «Значимые сообщения»; reposts, deliveries and revisions follow it.
    messages: [{ at: postedAt, kind: 'card', excerpt: cardLines.join(' · ') }, ...messages],
    closed_at: null,
    version: 1,
    ...fields,
  }
}

function openOrders(): OrderRecord[] {
  return [
    order(ORDER_ID.red, {
      title: 'вся в красном',
      buyer: 'фан №1482',
      account: 'lora-1',
      brief: 'Красное бельё и чулки, медленно раздеваться, смотреть в камеру.',
      duration: { raw: '12-15 минут', min_s: 720, max_s: 900 },
      wants_video: true,
      wants_photos: 0,
      deadline: '2026-09-19',
      fan_name: 'no',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 0,
          item_id: null,
          delivered_on: null,
          duration_s: null,
        },
      ],
      messages: [
        {
          at: mskInstant('2026-09-17', '19:40'),
          kind: 'repost',
          excerpt: '🔁 Кастом «вся в красном» · фан №1482 · до 19.09, фан спрашивает',
        },
      ],
      posted_on: '2026-09-10',
      card_lines: [
        '👤 фан №1482',
        '📄 вся в красном, медленно раздеваться',
        '⏱ 12-15 минут',
        '📅 до 19.09',
      ],
    }),
    order(ORDER_ID.bellyDance, {
      title: 'танец живота',
      buyer: 'фан №2210',
      account: 'lora-1',
      brief: 'Танец живота в комнате, около 4 минут.',
      duration: { raw: 'около 4 минут', min_s: 180, max_s: 300 },
      wants_video: true,
      wants_photos: 0,
      deadline: '2026-09-20',
      fan_name: 'unknown',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 1,
          item_id: 'CUS-195',
          delivered_on: '2026-09-19',
          duration_s: 221,
        },
      ],
      deliveries: [
        {
          id: 'dl-195',
          item_id: 'CUS-195',
          matched: ['ответ на карточку', 'слова в имени файла', '3:41 ≈ 4 мин', 'раздел Customs'],
          linked_by: ORDERS_AGENT,
          confirmed_by: DIANA,
          at: mskInstant('2026-09-19', '15:20'),
        },
      ],
      revisions: [
        {
          id: 'rev-195-1',
          text: 'без музыки, только звук комнаты',
          message_url: 'https://t.me/c/2627984998/9832',
          created_at: mskInstant('2026-09-20', '11:05'),
          created_by: DIANA,
          done: null,
        },
      ],
      messages: [
        {
          at: mskInstant('2026-09-19', '14:52'),
          kind: 'delivery',
          excerpt: '🎬 3:41 танец живота',
        },
        {
          at: mskInstant('2026-09-20', '11:02'),
          kind: 'revision',
          excerpt: 'Фан просит переделать: без музыки, только звук комнаты',
        },
      ],
      posted_on: '2026-09-12',
      card_lines: ['👤 фан №2210', '📄 танец живота', '⏱ около 4 минут', '📅 до 20.09'],
    }),
    order(ORDER_ID.lingerie, {
      title: 'примерка белья',
      buyer: 'фан №0937',
      account: 'lora-vip-of',
      brief: 'Примерка трёх комплектов белья, видео и фото каждого.',
      duration: { raw: '15 минут', min_s: 840, max_s: 960 },
      wants_video: true,
      wants_photos: 20,
      deadline: '2026-09-27',
      fan_name: 'no',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 1,
          item_id: 'CUS-192',
          delivered_on: '2026-09-17',
          duration_s: 900,
        },
        {
          kind: 'photos',
          required: 20,
          delivered: 0,
          item_id: null,
          delivered_on: null,
          duration_s: null,
        },
      ],
      deliveries: [
        {
          id: 'dl-192',
          item_id: 'CUS-192',
          matched: ['ответ на карточку', '15:00 ≈ 15 мин', 'раздел Customs'],
          linked_by: ORDERS_AGENT,
          confirmed_by: null,
          at: mskInstant('2026-09-17', '18:40'),
        },
      ],
      messages: [
        {
          at: mskInstant('2026-09-17', '18:31'),
          kind: 'delivery',
          excerpt: '🎬 15:00 примерка белья · фото пришлю завтра',
        },
      ],
      posted_on: '2026-09-11',
      card_lines: ['👤 фан №0937', '📄 примерка белья', '⏱ 15 минут', '🖼 20 фото', '📅 до 27.09'],
    }),
    order(ORDER_ID.blackSport, {
      title: 'в чёрном спорт',
      buyer: 'фан №3301',
      account: 'lora-2',
      brief: 'Чёрный спортивный комплект, растяжка и тизинг.',
      duration: { raw: '10 минут', min_s: 540, max_s: 660 },
      wants_video: true,
      wants_photos: 0,
      deadline: '2026-09-29',
      fan_name: 'yes',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 0,
          item_id: null,
          delivered_on: null,
          duration_s: null,
        },
      ],
      posted_on: '2026-09-18',
      card_lines: ['👤 фан №3301', '📄 в чёрном спорт', '⏱ 10 минут', '📅 до 29.09'],
    }),
    order(ORDER_ID.breastsButt, {
      title: 'грудь и попа',
      buyer: 'фан №1175',
      account: 'lora-1',
      brief: 'Крупно грудь и попа, без лица.',
      duration: { raw: 'около 3 минут', min_s: 150, max_s: 210 },
      wants_video: true,
      wants_photos: 0,
      deadline: '2026-09-24',
      fan_name: 'no',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 0,
          item_id: null,
          delivered_on: null,
          duration_s: null,
        },
      ],
      posted_on: '2026-09-19',
      card_lines: ['👤 фан №1175', '📄 грудь и попа', '⏱ около 3 минут', '📅 до 24.09'],
    }),
    order(ORDER_ID.breasts, {
      title: 'грудь',
      buyer: 'фан №2689',
      account: 'lora-3',
      brief: 'Грудь, медленно, при свечах.',
      duration: { raw: '3 минуты', min_s: 150, max_s: 210 },
      wants_video: true,
      wants_photos: 0,
      deadline: '2026-09-26',
      fan_name: 'unknown',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 0,
          item_id: null,
          delivered_on: null,
          duration_s: null,
        },
      ],
      posted_on: '2026-09-20',
      card_lines: ['👤 фан №2689', '📄 грудь', '⏱ 3 минуты', '📅 до 26.09'],
    }),
    order(ORDER_ID.boss, {
      title: 'Босс',
      buyer: 'фан №0418',
      account: 'lora-1',
      brief: 'Строгая начальница в офисе, около 15 минут.',
      duration: { raw: 'около 15 минут', min_s: 840, max_s: 1020 },
      wants_video: true,
      wants_photos: 0,
      deadline: '2026-09-21',
      fan_name: 'no',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 1,
          item_id: 'CUS-197',
          delivered_on: '2026-09-18',
          duration_s: 937,
        },
      ],
      deliveries: [
        {
          id: 'dl-197',
          item_id: 'CUS-197',
          matched: ['ответ на карточку', 'слова в имени файла', '15:37 ≈ 15 мин', 'раздел Customs'],
          linked_by: ORDERS_AGENT,
          confirmed_by: DIANA,
          at: mskInstant('2026-09-18', '16:30'),
        },
      ],
      messages: [
        {
          at: mskInstant('2026-09-18', '16:14'),
          kind: 'delivery',
          excerpt: '🎬 15:37 босс',
        },
      ],
      posted_on: '2026-09-12',
      card_lines: ['👤 фан №0418', '📄 Босс', '⏱ около 15 минут', '📅 до 21.09'],
    }),
  ]
}

/** Thirty closed orders, each with its delivered custom. */
function closedOrders(customs: readonly CatalogEntry[]): OrderRecord[] {
  const random = createRandom('lora-closed-orders')
  const delivered = customs
    .filter(
      (entry) =>
        !entry.photo_custom && Number(entry.id.slice(4)) >= 150 && Number(entry.id.slice(4)) < 181,
    )
    .slice(0, 30)
  return delivered.map((entry, index) => {
    const buyer = `фан №${String(random.int(100, 3999)).padStart(4, '0')}`
    const deliveredOn = entry.delivered_on ?? entry.arrived_on
    const record = order(`${CHAT}-${9000 + index * 17}`, {
      title: entry.title.toLowerCase(),
      buyer,
      account: random.pick(['lora-1', 'lora-2', 'lora-3', 'lora-vip-of'] as const),
      brief: null,
      duration: {
        raw: `${Math.round((entry.duration_s ?? 600) / 60)} минут`,
        min_s: null,
        max_s: null,
      },
      wants_video: true,
      wants_photos: 0,
      deadline: addDays(deliveredOn, 3),
      fan_name: entry.fan_name ?? 'unknown',
      parts: [
        {
          kind: 'video',
          required: null,
          delivered: 1,
          item_id: entry.id,
          delivered_on: deliveredOn,
          duration_s: entry.duration_s,
        },
      ],
      posted_on: addDays(deliveredOn, -5),
      card_lines: [`👤 ${buyer}`, `📄 ${entry.title.toLowerCase()}`],
    })
    record.closed_at = mskInstant(addDays(deliveredOn, 2), '10:00')
    return record
  })
}

/** Catalog patches the orders rely on: the delivered lingerie custom. */
export const ORDER_ITEM_PATCHES: Record<ItemId, Partial<CatalogEntry>> = {
  'CUS-192': {
    title: 'Примерка белья',
    duration_s: 900,
    photo_custom: false,
    arrived_on: '2026-09-17',
    delivered_on: '2026-09-17',
    fan_name: 'no',
    ppv_made_as: null,
    order_id: ORDER_ID.lingerie,
  },
}

export function buildLoraOrders(customs: readonly CatalogEntry[]): OrderRecord[] {
  return [...openOrders(), ...closedOrders(customs)]
}
