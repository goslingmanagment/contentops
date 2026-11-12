// Custom orders of the fake Agency Hub (`dev-hub.ts`; ecosystem plan 12.11.2026, package N): the
// hub's agent door as ContentOps uses it — the open orders, a delivery of a part, its retraction,
// a note — and the matters by reason key. A message is kept once per eventRef (else per link),
// the answer names the event it keeps; the hub derives «сдано частично» and «снято» from the
// parts, as the real one does. Every order, name and text here is made up.
//
// The developer moves an order the way the hub's board would:
//   POST /__dev/custom-orders                       {page?, task, duration?, photos?, deadline?}
//   POST /__dev/custom-orders/<code>/<step>          at_model | revision {note} | given | cancel
import type { LoggedRequest, Reply } from '@contentops/hub/testing'

type State = 'recorded' | 'paid' | 'at_model' | 'partly' | 'shot' | 'revision' | 'given' | 'cancelled'
type Part = 'video' | 'photos'

interface Message {
  telegramRef: string | null
  eventRef: string | null
  ordinal: number
  kind: 'repost' | 'delivery' | 'revision' | 'confirmation' | 'note'
  part: Part | null
  complete: boolean | null
  at: string | null
  author: string | null
  excerpt: string | null
  doneAt: string | null
  retractedAt: string | null
}

interface Order {
  id: number
  pageLabel: string | null
  model: string | null
  buyer: string
  card: { task: string; duration?: string; wantsVideo: boolean; wantsPhotos?: number; name?: string }
  deadlineOn: string | null
  state: State
  stateAt: string
  stateNote: string | null
  telegramRefs: string[]
  contentopsRef: string | null
  partsDone: Part[]
  version: number
  createdAt: string
  messages: Message[]
}

const MODEL_OF: Record<string, string> = { 'lora-1': 'Лора', 'lora-2': 'Лора', 'ari-1': 'Ари' }

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
}

export class DevOrders {
  readonly orders = new Map<number, Order>()
  readonly matters = new Map<string, { title: string; state: 'open' | 'closed' }>()
  #next = 101

  constructor() {
    this.create({ page: 'lora-1', task: 'вся в красном, медленно и с именем', duration: '5 минут', deadline: day(2), state: 'at_model' })
    this.create({ page: 'lora-2', task: 'в душе, камера на штативе', duration: '6-8 минут + 10 фото', photos: 10, deadline: day(-2), state: 'at_model' })
    this.create({ page: 'lora-1', task: 'чулки и каблуки, стриптиз', duration: '4 минуты', deadline: day(4), state: 'revision', note: 'фан просит без музыки' })
    this.create({ page: null, task: 'спортивный комплект', duration: '5 минут', deadline: day(1), state: 'shot', contentops: 'lora/tg-7000000001-3-501' })
    this.create({ page: 'lora-3', task: 'ещё не у модели', duration: '3 минуты', state: 'paid' })
    this.create({ page: 'ari-1', task: 'кастом Ари', duration: '5 минут', deadline: day(3), state: 'at_model' })
  }

  create(input: {
    page: string | null
    task: string
    duration?: string
    photos?: number
    deadline?: string
    state?: State
    note?: string
    contentops?: string
  }): Order {
    const id = this.#next++
    const now = new Date().toISOString()
    const order: Order = {
      id,
      pageLabel: input.page,
      model: input.page ? (MODEL_OF[input.page] ?? null) : null,
      buyer: `fan_${id}`,
      card: {
        task: input.task,
        wantsVideo: true,
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.photos ? { wantsPhotos: input.photos } : {}),
      },
      deadlineOn: input.deadline ?? null,
      state: input.state ?? 'at_model',
      stateAt: now,
      stateNote: input.note ?? null,
      telegramRefs: [`tg:7000000001/3/${20000 + id}`],
      contentopsRef: input.contentops ?? null,
      partsDone: input.state === 'shot' ? ['video'] : [],
      version: 1,
      createdAt: now,
      messages: input.note
        ? [{ telegramRef: `tg:7000000001/3/${30000 + id}`, eventRef: null, ordinal: 0, kind: 'revision', part: null, complete: null, at: now, author: 'менеджер', excerpt: input.note, doneAt: null, retractedAt: null }]
        : [],
    }
    this.orders.set(id, order)
    return order
  }

  #wanted(order: Order): Part[] {
    return [order.card.wantsVideo ? 'video' : null, (order.card.wantsPhotos ?? 0) > 0 ? 'photos' : null].filter(
      (part): part is Part => part !== null,
    )
  }

  #overdue(order: Order): number | null {
    if (!['at_model', 'partly', 'revision'].includes(order.state) || !order.deadlineOn) return null
    const days = Math.floor((Date.now() - Date.parse(`${order.deadlineOn}T21:00:00Z`)) / 86_400_000) + 1
    return days > 0 ? days : null
  }

  wire(order: Order) {
    const code = `K-${order.id}`
    const task = order.card.task
    return {
      id: order.id,
      code,
      pageLabel: order.pageLabel,
      platform: order.pageLabel ? (order.pageLabel.includes('of') ? 'onlyfans' : 'fansly') : null,
      model: order.model,
      fan: null,
      buyer: order.buyer,
      fanErased: false,
      card: order.card,
      what: task.split('\n')[0],
      deadlineOn: order.deadlineOn,
      state: order.state,
      stateAt: order.stateAt,
      stateNote: order.stateNote,
      stateRef: null,
      givenAt: null,
      givenMessageRef: null,
      acceptedBy: null,
      acceptedByName: null,
      telegramRefs: order.telegramRefs,
      contentopsRef: order.contentopsRef,
      origin: 'agent',
      overdueDays: this.#overdue(order),
      partsDone: order.partsDone,
      openRevisions: order.messages.filter((m) => m.kind === 'revision' && m.doneAt === null).length,
      version: order.version,
      createdAt: order.createdAt,
      updatedAt: order.stateAt,
      cardText: `📦 Описание заказа · ${code}\nПокупатель: ${order.buyer}\nДлительность: ${order.card.duration ?? '-'}\n🎥 ${task}`,
      sourceText: null,
      messages: order.messages,
    }
  }

  #move(order: Order, state: State, note: string | null = null) {
    order.state = state
    order.stateNote = note
    order.stateAt = new Date().toISOString()
    order.version++
  }

  handle(req: LoggedRequest): Reply | null {
    const { method, path } = req
    if (method === 'GET' && path === '/api/v1/agent/custom-orders') {
      const open = [...this.orders.values()].filter((o) => !['given', 'cancelled'].includes(o.state))
      return { status: 200, body: { orders: open.map((o) => this.wire(o)), serverNow: new Date().toISOString() } }
    }
    const step = /^\/api\/v1\/agent\/custom-orders\/K-(\d+)$/.exec(path)
    if (method === 'POST' && step) {
      const order = this.orders.get(Number(step[1]))
      if (!order) return { status: 404, body: { error: 'not_found', message: 'Not found' } }
      const body = req.json as {
        action: string; eventRef?: string; retracts?: string; reason?: string; part?: Part; complete?: boolean; kind?: string
        message?: { telegramRef?: string; at?: string; author?: string; excerpt?: string }
      }
      const ref = body.eventRef ?? body.message?.telegramRef ?? null
      if (ref === null) return { status: 400, body: { error: 'Bad Request', message: 'no eventRef and no message link' } }
      const kind = body.action === 'delivery' ? 'delivery' : 'note'
      const same = order.messages.find((m) => (body.eventRef ? m.eventRef === body.eventRef : m.eventRef === null && m.telegramRef === ref && m.ordinal === 0))
      if (same) {
        const event = same.kind === kind ? { ref, result: 'already' } : null
        return { status: 200, body: { order: this.wire(order), outcome: 'unchanged', event } }
      }
      if (body.action === 'retract') {
        const hits = order.messages.filter((m) => m.kind === 'delivery' && (m.eventRef === body.retracts || m.telegramRef === body.retracts))
        if (hits.length === 0) return { status: 409, body: { error: 'conflict', message: 'no such delivery', reason: 'unknown_event' } }
        for (const m of hits) m.retractedAt ??= new Date().toISOString()
        const live = order.messages.filter((m) => m.kind === 'delivery' && m.retractedAt === null && m.complete !== false)
        order.partsDone = order.partsDone.filter((part) => live.some((m) => m.part === part))
        if (order.state === 'shot' || order.state === 'partly') {
          this.#move(order, this.#wanted(order).every((part) => order.partsDone.includes(part)) ? 'shot' : order.partsDone.length > 0 ? 'partly' : 'at_model')
        }
      }
      order.messages.push({
        telegramRef: body.eventRef ? (body.message?.telegramRef ?? null) : ref,
        eventRef: body.eventRef ?? null,
        ordinal: 0,
        kind,
        part: body.action === 'delivery' ? (body.part ?? 'video') : null,
        complete: body.action === 'delivery' ? body.complete !== false : null,
        at: body.message?.at ?? null,
        author: body.message?.author ?? null,
        excerpt: body.message?.excerpt ?? body.reason ?? null,
        doneAt: null,
        retractedAt: null,
      })
      if (body.action === 'delivery' && ['recorded', 'paid', 'at_model', 'partly', 'revision'].includes(order.state)) {
        const parts = new Set(order.partsDone)
        if (body.complete !== false) parts.add(body.part ?? 'video')
        order.partsDone = [...parts]
        const open = order.state === 'revision'
        this.#move(order, open && body.complete === false ? 'revision' : this.#wanted(order).every((part) => parts.has(part)) ? 'shot' : 'partly')
      }
      return { status: 200, body: { order: this.wire(order), outcome: 'changed', event: { ref, result: 'stored' } } }
    }
    if (method === 'POST' && path === '/api/v1/agent/matters') {
      const body = req.json as { key: string; title: string }
      const was = this.matters.get(body.key)
      this.matters.set(body.key, { title: body.title, state: 'open' })
      process.stderr.write(`fake Hub: matter ${body.key} — ${body.title}\n`)
      return { status: 200, body: { matter: { id: 1, key: body.key, kind: body.key.split(':')[0], state: 'open', closedHow: null }, transition: was ? 'unchanged' : 'opened' } }
    }
    if (method === 'POST' && path === '/api/v1/agent/matters/close') {
      const body = req.json as { key: string }
      const was = this.matters.get(body.key)
      if (!was) return { status: 404, body: { error: 'not_found' } }
      was.state = 'closed'
      return { status: 200, body: { matter: { id: 1, key: body.key, kind: body.key.split(':')[0], state: 'closed', closedHow: 'resolved' }, transition: 'closed' } }
    }
    if (method === 'POST' && path === '/__dev/custom-orders') {
      const body = (req.json ?? {}) as { page?: string; task?: string; duration?: string; photos?: number; deadline?: string }
      const order = this.create({ page: body.page ?? 'lora-1', task: body.task ?? 'новый кастом', ...body, state: 'at_model' })
      return { status: 200, body: this.wire(order) }
    }
    const dev = /^\/__dev\/custom-orders\/K-(\d+)\/(at_model|revision|given|cancel)$/.exec(path)
    if (method === 'POST' && dev) {
      const order = this.orders.get(Number(dev[1]))
      if (!order) return { status: 404, body: { error: 'not_found' } }
      const note = (req.json as { note?: string } | undefined)?.note ?? 'правка'
      if (dev[2] === 'revision') {
        order.messages.push({
          telegramRef: `tg:7000000001/3/${40000 + order.messages.length}`, eventRef: null, ordinal: 0, kind: 'revision', part: null, complete: null,
          at: new Date().toISOString(), author: 'менеджер', excerpt: note, doneAt: null, retractedAt: null,
        })
        this.#move(order, 'revision', note)
      } else {
        this.#move(order, dev[2] === 'cancel' ? 'cancelled' : (dev[2] as State))
      }
      return { status: 200, body: this.wire(order) }
    }
    return null
  }
}
