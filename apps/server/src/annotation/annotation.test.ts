import { createHash, randomUUID } from 'node:crypto'
import {
  enqueueWork,
  SYSTEM_ACTOR,
  WorkError,
  WorkPaused,
  type WorkRow,
  withActorTx,
} from '@contentops/db'
import { FAKE_KEY } from '@contentops/vision/testing'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { markupFields } from '../catalog/markup'
import { createWorkGate } from '../work-gate'
import { applySuggestions, fieldVersions } from './apply'
import { reserve, spentSince } from './money'
import { annotationSettings } from './settings'
import {
  allowMarkup,
  annotateOnce,
  consent,
  deliveredOrder,
  type FramedItem,
  framedItem,
  type MarkupStand,
  markupStand,
  ROUTINE_CUS,
  ROUTINE_PPV,
  setPolicy,
} from './testing'
import { enqueueAnnotation } from './work'

/**
 * The checks of PLAN 8а before the first external request (SPEC §8.3): what goes out is built
 * from the allowed fields only — never the title, paths, file names, order texts, account IDs,
 * the model's name, metadata of the frames — in every request and in the journal; what a policy
 * keeps back is not sent; the reserve holds the budget and the limit; a switched-off route sends
 * nothing; a refusal is a normal outcome. The providers are fake servers, there is no network.
 */

let stand: MarkupStand
let number = 900

beforeAll(async () => {
  stand = await markupStand()
})
afterAll(() => stand.close())

/** Every test starts with nothing set and both providers just «turned on» by the owner. */
beforeEach(async () => {
  await withActorTx(
    stand.db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.reset', requestId: randomUUID() },
    (tx) => tx.execute(sql`DELETE FROM policy_settings WHERE key LIKE 'annotation.%'`),
  )
  const now = new Date().toISOString()
  await setPolicy(stand.db, 'annotation.resumed.openai', { at: now })
  await setPolicy(stand.db, 'annotation.resumed.anthropic', { at: now })
  stand.fake.requests.splice(0)
})

const next = () => {
  number += 1
  return number
}

async function runsOf(item: FramedItem) {
  const { rows } = await stand.db.execute<{
    stage: string
    provider: string
    state: string
    error_code: string | null
    cost_usd: number | null
    reserved_usd: number | null
    outcome_unknown: boolean
  }>(sql`
    SELECT stage, provider, state, error_code, cost_usd::float8 AS cost_usd,
           reserved_usd::float8 AS reserved_usd, outcome_unknown
      FROM annotation_runs WHERE item_id = ${item.itemId}::uuid ORDER BY created_at, attempt`)
  return rows
}

function pausedKey(error: unknown): string | null {
  return error instanceof WorkPaused ? error.key : null
}

/** The fields as the card shows them to the manager (DESIGN §5.4). */
async function statusesOf(item: FramedItem) {
  const { rows } = await stand.db.execute<{
    title: string | null
    title_en: string | null
    description: string | null
  }>(sql`SELECT title, title_en, description FROM content_items WHERE id = ${item.itemId}::uuid`)
  const row = rows[0]
  const fields = await markupFields(stand.db, { id: stand.lora, code: 'lora', name: 'Лора' }, [
    {
      uid: item.itemId,
      type: 'PPV',
      title: row?.title ?? null,
      title_en: row?.title_en ?? null,
      description: row?.description ?? null,
    },
  ])
  return Object.fromEntries(
    (fields.get(item.itemId) ?? []).map((field) => [
      field.field.key,
      { status: field.status, hint: field.source_hint },
    ]),
  )
}

describe('what goes out (SPEC §8.3, PLAN 8а)', () => {
  it('builds every request from the allowed fields only; the journal keeps no content', async () => {
    const POISON = {
      title: 'Секретное название из папки',
      path: '/srv/content/blobs/ab/cd/секрет.mp4',
      file: 'IMG_5001.MOV',
      link: 'https://t.me/c/1234/56',
      handle: '@LoraVie',
      brief: 'Хочу чтобы ты назвала меня Иваном и станцевала в красном',
      card: 'Карточка: десять минут, красное бельё, имя Иван в кадре',
      exif: 'EXIF-SECRET-42',
    }
    const ppv = await framedItem(stand, {
      type: 'PPV',
      number: next(),
      title: POISON.title,
      description: `Лора танцует у окна. ${POISON.file} лежит в ${POISON.path}. Карточка ${POISON.link}, страница ${POISON.handle}, lora-1.`,
      notes: true,
      exif: POISON.exif,
    })
    const cus = await framedItem(stand, {
      type: 'CUS',
      number: next(),
      description: `${POISON.brief}. Танец у окна в мягком свете.`,
      notes: true,
      exif: POISON.exif,
    })
    await deliveredOrder(stand, cus, { brief: POISON.brief, card: POISON.card })
    await allowMarkup(stand.db, ['openai'])

    expect((await annotateOnce(stand, ppv, ROUTINE_PPV)).error).toBeNull()
    expect((await annotateOnce(stand, cus, ROUTINE_CUS)).error).toBeNull()
    const requests = stand.fake.requests
    expect(requests.map((request) => request.stage)).toEqual([
      'observe',
      'aggregate',
      'texts',
      'observe',
      'aggregate',
    ])

    const { rows: ids } = await stand.db.execute<{ id: string }>(sql`
      SELECT id::text FROM accounts UNION ALL SELECT id::text FROM models
      UNION ALL SELECT id::text FROM content_items UNION ALL SELECT id::text FROM asset_versions
      UNION ALL SELECT id::text FROM custom_orders`)
    const forbidden = [
      POISON.title,
      'IMG_5001',
      '/srv/',
      'секрет.mp4',
      't.me',
      'LoraVie',
      'Лора',
      'lora-1',
      'назвала меня Иваном',
      'красное бельё, имя Иван',
      POISON.exif,
      ppv.publicId,
      cus.publicId,
      FAKE_KEY,
      ...ids.map((row) => row.id),
    ]
    for (const request of requests) {
      const body = request.raw.toString('utf8')
      for (const word of forbidden) expect(body, `${request.stage}: ${word}`).not.toContain(word)
    }
    // The pictures: re-encoded, without EXIF or XMP, at most 512 px.
    const pictures = requests
      .filter((request) => request.stage === 'observe')
      .flatMap((request) => [
        ...request.raw.toString('utf8').matchAll(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/g),
      ])
      .map((match) => Buffer.from(match[1] ?? '', 'base64'))
    expect(pictures).toHaveLength(8)
    for (const picture of pictures) {
      const meta = await sharp(picture).metadata()
      expect(meta.exif).toBeUndefined()
      expect(meta.xmp).toBeUndefined()
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(512)
      expect(picture.toString('latin1')).not.toContain(POISON.exif)
    }
    // The notes go cleaned: the model's names, the page, the path, the file and the order out.
    const ppvNotes = requests[1]?.context?.notes
    expect(ppvNotes).toContain('модель танцует у окна')
    expect(ppvNotes).toContain('[файл]')
    expect(ppvNotes).toContain('[путь]')
    expect(requests[4]?.context?.notes).toBe('Танец у окна в мягком свете.')

    // The receipts: one per request, its hash and size of the bytes that arrived, no content.
    const { rows: receipts } = await stand.db.execute<{ after: Record<string, unknown> }>(sql`
      SELECT after FROM action_log
       WHERE action = 'annotation.request' AND entry_kind = 'action' ORDER BY id`)
    expect(receipts).toHaveLength(5)
    for (const [index, receipt] of receipts.entries()) {
      const raw = requests[index]?.raw ?? Buffer.alloc(0)
      expect(receipt.after.sent_sha256).toBe(createHash('sha256').update(raw).digest('hex'))
      expect(receipt.after.sent_bytes).toBe(raw.length)
      expect(receipt.after.outcome).toBe('answered')
      expect(Number(receipt.after.cost_usd)).toBeGreaterThan(0)
    }
    // The receipts name nothing of the object; the rows of the fields the markup wrote — the
    // catalog's own journal of «было → стало» — carry no path, file, link, order or metadata.
    const { rows: journal } = await stand.db.execute<{ text: string; kind: string }>(sql`
      SELECT coalesce(before::text, '') || coalesce(after::text, '') || subject_label AS text,
             entry_kind AS kind
        FROM action_log WHERE action LIKE 'annotation.%'`)
    expect(journal.length).toBeGreaterThan(receipts.length)
    const content = [POISON.path, 'IMG_5001', POISON.link, POISON.brief, POISON.card, POISON.exif]
    for (const row of journal) {
      // A receipt names its object and frames by reference only (SPEC §8.3 «ссылки на кадры»).
      const words =
        row.kind === 'action'
          ? [...content, POISON.title, 'Лора', 'LoraVie', 'lora-1', FAKE_KEY, 'модель танцует']
          : content
      for (const word of words) expect(row.text, word).not.toContain(word)
    }

    // What came back: a draft of the AI where nobody confirmed; the manager's notes stay.
    const { rows: fields } = await stand.db.execute<{
      title: string
      description: string
      confirmed: boolean
      run: string | null
    }>(sql`
      SELECT i.title, i.description,
             f.confirmed_value_version IS NOT DISTINCT FROM f.value_version AS confirmed,
             f.suggested_by_run_id::text AS run
        FROM content_items i
        JOIN annotation_fields f ON f.model_id = i.model_id AND f.item_id = i.id AND f.field = 'title'
       WHERE i.id = ${ppv.itemId}::uuid`)
    expect(fields[0]).toMatchObject({ title: 'Кружево у окна', confirmed: false })
    expect(fields[0]?.run).not.toBeNull()
    expect(fields[0]?.description).toContain(POISON.file)
    const { rows: texts } = await stand.db.execute<{ source: string; confirmed: boolean }>(sql`
      SELECT source, confirmed_value_version IS NOT NULL AS confirmed FROM platform_texts
       WHERE item_id = ${ppv.itemId}::uuid ORDER BY variant_no`)
    expect(texts).toEqual([
      { source: 'ai', confirmed: false },
      { source: 'ai', confirmed: false },
    ])
    // The card: «черновик · ИИ» where the run wrote, the manager's notes stay confirmed.
    expect(await statusesOf(ppv)).toMatchObject({
      title: { status: 'draft_ai' },
      title_en: { status: 'draft_ai' },
      tags: { status: 'draft_ai' },
      description: { status: 'confirmed' },
      timeline: { status: 'draft_ai' },
      platform_texts: { status: 'draft_ai' },
    })
  })

  it('sends nothing a consent leaves out', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    await allowMarkup(stand.db, ['openai'])
    await setPolicy(stand.db, 'annotation.external.openai', consent({ types: ['FYP'] }))
    const { report } = await annotateOnce(stand, item, ROUTINE_PPV)
    expect(report).toMatchObject({ stages: [{ kind: 'held', stage: 'observe' }] })
    await setPolicy(stand.db, 'annotation.external.openai', consent({ frames: false }))
    expect((await annotateOnce(stand, item, ROUTINE_PPV)).report).toMatchObject({
      stages: [{ kind: 'held', reason: 'согласие не включает кадры' }],
    })
    expect(stand.fake.requests).toHaveLength(0)
    expect(await runsOf(item)).toEqual([])
    const { rows } = await stand.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM action_log
       WHERE action = 'annotation.held' AND item_id = ${item.itemId}::uuid`)
    expect(rows[0]?.n).toBe(2)
  })

  it('a route switched off queues nothing and sends nothing', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    const queue = () =>
      enqueueAnnotation(stand.db, { modelId: stand.lora, itemId: item.itemId, pass: randomUUID() })
    expect(await queue()).toEqual({
      queued: false,
      reason: 'разметка выключена (annotation.enabled)',
    })
    await setPolicy(stand.db, 'annotation.enabled', true)
    expect(await queue()).toEqual({ queued: false, reason: 'у PPV нет маршрута кадров' })

    // Queued while on, switched off before the worker took it: it waits, nothing goes out.
    await allowMarkup(stand.db, ['openai'])
    const queued = await queue()
    expect(queued).toMatchObject({ queued: true, stages: ['observe', 'aggregate', 'texts'] })
    await setPolicy(stand.db, 'annotation.enabled', false)
    if (!queued.queued) throw new Error('not queued')
    expect(await createWorkGate()(queued.work, stand.db)).toBe('annotation.enabled')
    await setPolicy(stand.db, 'annotation.enabled', true)
    await setPolicy(stand.db, 'annotation.route.PPV.observe', null)
    const { error } = await annotateOnce(stand, item, ROUTINE_PPV)
    expect(pausedKey(error)).toBe('annotation.route.PPV.observe')
    expect(stand.fake.requests).toHaveLength(0)
  })
})

describe('money and outcomes (SPEC §8.3)', () => {
  it('holds the budget and a provider’s limit before the send', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    await allowMarkup(stand.db, ['openai'], { usd: 0.0001 })
    expect(pausedKey((await annotateOnce(stand, item, ROUTINE_PPV)).error)).toBe(
      'annotation.budget',
    )
    await setPolicy(stand.db, 'annotation.budget', { usd: 5, since: new Date().toISOString() })
    await setPolicy(stand.db, 'annotation.limit.openai', { usd: 0.0001 })
    expect(pausedKey((await annotateOnce(stand, item, ROUTINE_PPV)).error)).toBe(
      'annotation.limit.openai',
    )
    expect(stand.fake.requests).toHaveLength(0)
    expect(await runsOf(item)).toEqual([])
  })

  it('two reserves at once never spend the same dollar', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    const budget = { usd: 1000, since: '2026-01-01T00:00:00.000Z' }
    // A route of its own, so the dollars of the other tests do not count.
    const route = `test.${randomUUID()}`
    const take = () =>
      withActorTx(
        stand.db,
        { actor: SYSTEM_ACTOR('test'), action: 'test.reserve', requestId: randomUUID() },
        async (tx) => {
          const fits = await reserve(tx, {
            budget,
            provider: 'openai',
            providerLimit: null,
            route,
            routeKey: 'annotation.route.TEST.observe',
            routeLimit: 1,
            amount: 0.6,
          })
          if (fits.ok) {
            await tx.execute(sql`
              INSERT INTO annotation_runs (model_id, item_id, stage, route, provider, model_name,
                                           prompt_version, input_sha256, config_digest,
                                           billing_scope, state, reserved_usd, sent_at)
              VALUES (${stand.lora}::uuid, ${item.itemId}::uuid, 'observe', ${route}, 'openai',
                      'm', 'p', ${item.master}, ${randomUUID()}, 'openai', 'running', 0.6, now())`)
          }
          return fits.ok
        },
      )
    expect((await Promise.all([take(), take()])).filter(Boolean)).toHaveLength(1)
    expect((await spentSince(stand.db, budget.since, 'openai', route)).route).toBeCloseTo(0.6)
  })

  it('an unknown outcome is paid at its reserve and never sent again', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    await allowMarkup(stand.db, ['openai'])
    stand.fake.next('lost_answer')
    const first = await annotateOnce(stand, item, ROUTINE_PPV)
    expect(first.error).toBeInstanceOf(WorkError)
    expect((first.error as WorkError).code).toBe('outcome_unknown')
    const [run] = await runsOf(item)
    expect(run).toMatchObject({ state: 'failed', outcome_unknown: true })
    expect(run?.cost_usd).toBe(run?.reserved_usd)
    const again = await annotateOnce(stand, item, ROUTINE_PPV)
    expect((again.error as WorkError).code).toBe('outcome_unknown')
    expect(stand.fake.requests).toHaveLength(1)
  })

  it('a refusal leaves the fields drafts with the reason; the spare tries once, then the manager', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next(), title: 'Старое название' })
    await withActorTx(
      stand.db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.confirm', requestId: randomUUID() },
      async (tx) => {
        await tx.execute(sql`
          UPDATE content_items SET title_en = 'Kept title' WHERE id = ${item.itemId}::uuid`)
        await tx.execute(sql`
          INSERT INTO annotation_fields (model_id, item_id, field, value_version,
                                         confirmed_value_version, confirmed_at)
          VALUES (${stand.lora}::uuid, ${item.itemId}::uuid, 'title_en', 1, 1, now())`)
      },
    )
    await allowMarkup(stand.db, ['openai', 'anthropic'])
    stand.fake.next('refuse', 'policy_error')
    const { report } = await annotateOnce(stand, item, ROUTINE_PPV)
    expect(report).toMatchObject({ stages: [{ kind: 'refused', stage: 'observe' }] })
    expect(stand.fake.of('openai')).toHaveLength(1)
    expect(stand.fake.of('anthropic')).toHaveLength(1)
    expect((await runsOf(item)).map((run) => [run.provider, run.state])).toEqual([
      ['openai', 'refused'],
      ['anthropic', 'refused'],
    ])
    const { rows: failed } = await stand.db.execute<{ field: string }>(sql`
      SELECT DISTINCT s.field FROM annotation_suggestions s
        JOIN annotation_runs r ON r.model_id = s.model_id AND r.id = s.run_id
       WHERE r.item_id = ${item.itemId}::uuid AND s.refusal_reason IS NOT NULL AND s.value IS NULL
       ORDER BY s.field`)
    expect(failed.map((row) => row.field)).toEqual([
      'chronology',
      'description',
      'observations',
      'platform_texts',
      'tags',
      'title',
      'title_en',
    ])
    const { rows: kept } = await stand.db.execute<{ title: string; title_en: string }>(sql`
      SELECT title, title_en FROM content_items WHERE id = ${item.itemId}::uuid`)
    expect(kept[0]).toEqual({ title: 'Старое название', title_en: 'Kept title' })
    // The card: «не удалось · разметить вручную» with the reason; the value is not wiped.
    const statuses = await statusesOf(item)
    expect(statuses.title).toMatchObject({ status: 'ai_failed' })
    expect(statuses.title?.hint).toMatch(/flagged|policy/i)
    expect(statuses.title_en).toMatchObject({ status: 'confirmed' })
    // No repeat to the same provider with the same input.
    expect((await annotateOnce(stand, item, ROUTINE_PPV)).report).toMatchObject({
      stages: [{ kind: 'refused' }],
    })
    expect(stand.fake.requests).toHaveLength(2)
  })

  it('a refused key stops the provider until the owner turns it on again', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    await allowMarkup(stand.db, ['openai'])
    stand.fake.next('unauthorized')
    expect(pausedKey((await annotateOnce(stand, item, ROUTINE_PPV)).error)).toBe(
      'annotation.resumed.openai',
    )
    expect(pausedKey((await annotateOnce(stand, item, ROUTINE_PPV)).error)).toBe(
      'annotation.resumed.openai',
    )
    expect(stand.fake.requests).toHaveLength(1)
    await setPolicy(stand.db, 'annotation.resumed.openai', { at: new Date().toISOString() })
    expect((await annotateOnce(stand, item, ROUTINE_PPV)).error).toBeNull()
    expect(stand.fake.requests.length).toBeGreaterThan(1)
  })

  it('a late answer never overwrites a field a person confirmed meanwhile', async () => {
    const item = await framedItem(stand, { type: 'PPV', number: next() })
    const seen = await fieldVersions(stand.db, stand.lora, item.itemId, item.versionId)
    await withActorTx(
      stand.db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.edit', requestId: randomUUID() },
      async (tx) => {
        await tx.execute(sql`
          UPDATE content_items SET title = 'Название Дианы' WHERE id = ${item.itemId}::uuid`)
        await tx.execute(sql`
          INSERT INTO annotation_fields (model_id, item_id, field, value_version,
                                         confirmed_value_version, confirmed_at)
          VALUES (${stand.lora}::uuid, ${item.itemId}::uuid, 'title', 1, 1, now())`)
      },
    )
    const { rows } = await stand.db.execute<{ id: string }>(sql`
      INSERT INTO annotation_runs (model_id, item_id, stage, route, provider, model_name,
                                   prompt_version, input_sha256, config_digest, billing_scope,
                                   state, finished_at)
      VALUES (${stand.lora}::uuid, ${item.itemId}::uuid, 'aggregate', 'PPV.aggregate', 'openai',
              'm', 'p', ${item.master}, ${randomUUID()}, 'openai', 'succeeded', now())
      RETURNING id`)
    const applied = await withActorTx(
      stand.db,
      { actor: SYSTEM_ACTOR('test'), action: 'test.apply', requestId: randomUUID() },
      (tx) =>
        applySuggestions(
          tx,
          {
            modelId: stand.lora,
            itemId: item.itemId,
            versionId: item.versionId,
            runId: rows[0]?.id ?? '',
            seen,
          },
          { title: 'Название ИИ', description: 'Описание ИИ' },
        ),
    )
    expect([...applied.keys()]).toEqual(['description'])
    const { rows: now } = await stand.db.execute<{ title: string; description: string }>(sql`
      SELECT title, description FROM content_items WHERE id = ${item.itemId}::uuid`)
    expect(now[0]).toEqual({ title: 'Название Дианы', description: 'Описание ИИ' })
  })

  it('reads the settings as the owner wrote them; a value off its schema counts as not set', async () => {
    await setPolicy(stand.db, 'annotation.route.PPV.observe', { providers: [] })
    await setPolicy(stand.db, 'annotation.route.CUS.observe', {
      providers: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    })
    const settings = await annotationSettings(stand.db, stand.lora)
    expect(settings.routes.has('PPV.observe')).toBe(false)
    expect(settings.routes.get('CUS.observe')?.providers[0]?.model).toBe('claude-opus-5-5')
    expect(settings.enabled).toBe(false)
    expect(settings.budget).toBeNull()
    // A work of the measurement passes the gate whatever the switch says.
    const { work } = await enqueueWork(stand.db, {
      modelId: stand.lora,
      kind: 'annotate',
      workKey: `annotate:gate:${randomUUID()}`,
      scope: randomUUID(),
      dataset: 'probe',
    })
    expect(await createWorkGate()(work as WorkRow, stand.db)).toBeNull()
  })
})
