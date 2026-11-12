import { badShape, int, isRecord, str, strArray } from './http.ts'

/**
 * The hub's custom orders as its agent door gives them (hub `packages/contracts/src/
 * custom-orders.ts`, `agentCustomOrderSchema`; ecosystem plan 12.11.2026, packages I and N).
 * The order's home is the hub: ContentOps reads the open ones with its key (`write:customs`),
 * shows those in production with the files it holds, and tells the hub what a file means —
 * a delivery of a part, or a retraction as a note. It never creates, closes or gives one.
 */

export const HUB_ORDER_STATES = [
  'recorded',
  'paid',
  'at_model',
  'partly',
  'shot',
  'revision',
  'refused',
  'given',
  'closed',
  'cancelled',
] as const
export type HubOrderState = (typeof HUB_ORDER_STATES)[number]

export const HUB_ORDER_MESSAGE_KINDS = [
  'repost',
  'delivery',
  'revision',
  'confirmation',
  'note',
] as const
export type HubOrderMessageKind = (typeof HUB_ORDER_MESSAGE_KINDS)[number]

export type HubOrderPart = 'video' | 'photos'

export interface HubOrderMessage {
  telegramRef: string
  ordinal: number
  kind: HubOrderMessageKind
  part: HubOrderPart | null
  at: string | null
  author: string | null
  excerpt: string | null
  /** A revision request: when it was fixed. */
  doneAt: string | null
}

/** The fields of the card ContentOps reads (the card is the hub's small document). */
export interface HubOrderCard {
  name?: string
  duration?: string
  task?: string
  deadlineNote?: string
  nameInVideo?: 'yes' | 'no' | 'unknown'
  wantsVideo?: boolean
  wantsPhotos?: number
}

/** One open order as the hub's agent read gives it: no money. */
export interface HubCustomOrder {
  id: number
  /** `K-<n>`: never one of ContentOps' `CUS-217`. */
  code: string
  /** Null — the page is not known (an imported order). */
  pageLabel: string | null
  platform: string | null
  model: string | null
  fan: { username: string | null; displayName: string | null } | null
  buyer: string | null
  card: HubOrderCard
  /** The task's first line. */
  what: string
  deadlineOn: string | null
  state: HubOrderState
  stateAt: string
  stateNote: string | null
  stateRef: string | null
  telegramRefs: string[]
  /** ContentOps' old order the hub's import made it from: `<model>/<address>`. */
  contentopsRef: string | null
  overdueDays: number | null
  partsDone: HubOrderPart[]
  openRevisions: number
  version: number
  createdAt: string
  updatedAt: string
  /** The card's text with the code, as «Скопировать карточку» gives it. */
  cardText: string
  sourceText: string | null
  messages: HubOrderMessage[]
}

export interface HubCustomOrderList {
  orders: HubCustomOrder[]
  serverNow: string | null
}

export interface HubCustomOrderAnswer {
  order: HubCustomOrder
  outcome: 'created' | 'changed' | 'unchanged'
}

/** A Telegram message of the order as the hub's agent body names it. */
export interface HubOrderMessageInput {
  telegramRef: string
  at?: string
  author?: string
  excerpt?: string
}

/** The two steps ContentOps takes: a delivery of a part, and a note (a retraction). */
export type HubOrderReportBody =
  | {
      action: 'delivery'
      message: HubOrderMessageInput
      part: HubOrderPart
      complete: boolean
    }
  | { action: 'message'; kind: 'note'; message: HubOrderMessageInput }

const CODE = /^K-[1-9]\d{0,15}$/
const PARTS: readonly string[] = ['video', 'photos']

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function parseMessage(raw: unknown, endpoint: string, at: string): HubOrderMessage {
  if (!isRecord(raw)) throw badShape(endpoint, `${at}: a message is not an object`)
  const telegramRef = str(raw.telegramRef)
  const kind = oneOf(HUB_ORDER_MESSAGE_KINDS, raw.kind)
  if (telegramRef === null || kind === null) {
    throw badShape(endpoint, `${at}: a message without its link or kind`)
  }
  const part = oneOf(['video', 'photos'] as const, raw.part)
  return {
    telegramRef,
    ordinal: int(raw.ordinal) ?? 0,
    kind,
    part,
    at: str(raw.at),
    author: str(raw.author),
    excerpt: str(raw.excerpt),
    doneAt: str(raw.doneAt),
  }
}

function parseCard(raw: unknown): HubOrderCard {
  if (!isRecord(raw)) return {}
  const card: HubOrderCard = {}
  const text = (key: 'name' | 'duration' | 'task' | 'deadlineNote') => {
    const value = str(raw[key])
    if (value !== null) card[key] = value
  }
  text('name')
  text('duration')
  text('task')
  text('deadlineNote')
  const name = oneOf(['yes', 'no', 'unknown'] as const, raw.nameInVideo)
  if (name !== null) card.nameInVideo = name
  if (typeof raw.wantsVideo === 'boolean') card.wantsVideo = raw.wantsVideo
  const photos = int(raw.wantsPhotos)
  if (photos !== null && photos >= 0) card.wantsPhotos = photos
  return card
}

/**
 * One order of the agent read. The fields ContentOps uses must be there and of their kind;
 * the rest of the hub's order passes untouched (a field the hub adds breaks nothing).
 */
export function parseHubOrder(raw: unknown, endpoint = 'custom-orders'): HubCustomOrder {
  if (!isRecord(raw)) throw badShape(endpoint, 'an order is not an object')
  const code = str(raw.code)
  const id = int(raw.id)
  const state = oneOf(HUB_ORDER_STATES, raw.state)
  const version = int(raw.version)
  if (code === null || !CODE.test(code) || id === null || state === null || version === null) {
    throw badShape(endpoint, 'an order without its code, number, state or version')
  }
  if (!Array.isArray(raw.messages)) throw badShape(endpoint, `${code}: no \`messages\` list`)
  const fan = isRecord(raw.fan)
    ? { username: str(raw.fan.username), displayName: str(raw.fan.displayName) }
    : null
  return {
    id,
    code,
    pageLabel: str(raw.pageLabel),
    platform: str(raw.platform),
    model: str(raw.model),
    fan,
    buyer: str(raw.buyer),
    card: parseCard(raw.card),
    what: str(raw.what) ?? '',
    deadlineOn: str(raw.deadlineOn),
    state,
    stateAt: str(raw.stateAt) ?? str(raw.updatedAt) ?? '',
    stateNote: str(raw.stateNote),
    stateRef: str(raw.stateRef),
    telegramRefs: strArray(raw.telegramRefs),
    contentopsRef: str(raw.contentopsRef),
    overdueDays: int(raw.overdueDays),
    partsDone: strArray(raw.partsDone).filter((part): part is HubOrderPart => PARTS.includes(part)),
    openRevisions: int(raw.openRevisions) ?? 0,
    version,
    createdAt: str(raw.createdAt) ?? '',
    updatedAt: str(raw.updatedAt) ?? '',
    cardText: str(raw.cardText) ?? '',
    sourceText: str(raw.sourceText),
    messages: raw.messages.map((message, i) => parseMessage(message, endpoint, `${code}#${i}`)),
  }
}

export function parseHubOrderList(json: unknown, endpoint = 'custom-orders'): HubCustomOrderList {
  if (!isRecord(json) || !Array.isArray(json.orders)) throw badShape(endpoint, 'no `orders` list')
  return {
    orders: json.orders.map((order) => parseHubOrder(order, endpoint)),
    serverNow: str(json.serverNow),
  }
}

export function parseHubOrderAnswer(json: unknown, endpoint: string): HubCustomOrderAnswer {
  if (!isRecord(json)) throw badShape(endpoint, 'the answer is not an object')
  const outcome = oneOf(['created', 'changed', 'unchanged'] as const, json.outcome)
  if (outcome === null) throw badShape(endpoint, 'no `outcome`')
  return { order: parseHubOrder(json.order, endpoint), outcome }
}

// ---------------------------------------------------------------------------
// Matters (hub `packages/contracts/src/matters.ts`, capability `write:matters`)
// ---------------------------------------------------------------------------

/** A matter ContentOps opens by its reason key: `<kind>:<ref>`, the same finding the same key. */
export interface HubMatterOpen {
  key: string
  kind: string
  title: string
  owner: { role: 'owner' | 'team_lead' | 'chatter' } | { user: string }
  pageLabels?: string[]
  object?: { type: string; id: string }
  evidence?: Record<string, unknown>
}

export interface HubMatterAnswer {
  key: string
  state: 'open' | 'closed'
  transition: 'opened' | 'reopened' | 'updated' | 'unchanged' | 'closed'
}

export function parseMatterAnswer(json: unknown, endpoint: string): HubMatterAnswer {
  if (!isRecord(json) || !isRecord(json.matter)) throw badShape(endpoint, 'no `matter`')
  const key = str(json.matter.key)
  const state = oneOf(['open', 'closed'] as const, json.matter.state)
  const transition = oneOf(
    ['opened', 'reopened', 'updated', 'unchanged', 'closed'] as const,
    json.transition,
  )
  if (key === null || state === null || transition === null) {
    throw badShape(endpoint, 'a matter without its key, state or transition')
  }
  return { key, state, transition }
}
