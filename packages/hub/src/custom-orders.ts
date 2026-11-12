import { badShape, int, isRecord, str, strArray } from './http.ts'

/**
 * The hub's custom orders as its agent door gives them (hub `packages/contracts/src/
 * custom-orders.ts`, `agentCustomOrderSchema`; ecosystem plan 12.11.2026, packages I and N).
 * The order's home is the hub: ContentOps reads the open ones with its key (`write:customs`),
 * shows those in production with the files it holds, and tells the hub what a file means —
 * a delivery of a part, or its retraction, each named by ContentOps' own id of it (`eventRef`).
 * It never creates, closes or gives one.
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
  /** The Telegram message: what the hub knows it by, or an event's evidence; null — none. */
  telegramRef: string | null
  /** The sender's own id of the event (`contentops:delivery:<id>`); null — a Telegram message. */
  eventRef: string | null
  ordinal: number
  kind: HubOrderMessageKind
  part: HubOrderPart | null
  /** A delivery: that part whole; null — not said. */
  complete: boolean | null
  at: string | null
  author: string | null
  excerpt: string | null
  /** A revision request: when it was fixed. */
  doneAt: string | null
  /** A delivery taken back. */
  retractedAt: string | null
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

/** The event a step names, and what the hub did with it: kept now, or had this very one. */
export interface HubOrderEvent {
  ref: string
  result: 'stored' | 'already'
}

export interface HubCustomOrderAnswer {
  order: HubCustomOrder
  outcome: 'created' | 'changed' | 'unchanged'
  /** Null — the hub keeps no such event (or is older than events): the report is not in the hub. */
  event: HubOrderEvent | null
}

/** A Telegram message of the order as the hub's agent body names it; with `eventRef` its evidence. */
export interface HubOrderMessageInput {
  telegramRef?: string
  at?: string
  author?: string
  excerpt?: string
}

/**
 * The steps ContentOps takes, each known by ContentOps' own id (`eventRef`): a delivery of a part,
 * and its retraction (`retracts` — the delivery's eventRef, or the Telegram link an older report
 * named it by). A note under a link is the old form of a retraction: reports written before
 * events keep it.
 */
export type HubOrderReportBody =
  | {
      action: 'delivery'
      eventRef?: string
      message: HubOrderMessageInput
      part: HubOrderPart
      complete: boolean
    }
  | { action: 'message'; kind: 'note'; eventRef?: string; message: HubOrderMessageInput }
  | {
      action: 'retract'
      eventRef: string
      retracts: string
      reason: string
      message?: HubOrderMessageInput
    }

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
  const eventRef = str(raw.eventRef)
  const kind = oneOf(HUB_ORDER_MESSAGE_KINDS, raw.kind)
  if ((telegramRef === null && eventRef === null) || kind === null) {
    throw badShape(endpoint, `${at}: a message without its link (or event) or kind`)
  }
  const part = oneOf(['video', 'photos'] as const, raw.part)
  return {
    telegramRef,
    eventRef,
    ordinal: int(raw.ordinal) ?? 0,
    kind,
    part,
    complete: typeof raw.complete === 'boolean' ? raw.complete : null,
    at: str(raw.at),
    author: str(raw.author),
    excerpt: str(raw.excerpt),
    doneAt: str(raw.doneAt),
    retractedAt: str(raw.retractedAt),
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
  const raw = isRecord(json.event) ? json.event : null
  const ref = raw ? str(raw.ref) : null
  const result = raw ? oneOf(['stored', 'already'] as const, raw.result) : null
  const event = ref !== null && result !== null ? { ref, result } : null
  return { order: parseHubOrder(json.order, endpoint), outcome, event }
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
  /** A path of the hub's console where it is done (`/workboard/customs/K-123`). */
  link?: string
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
