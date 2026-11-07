import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KNOWN_PRICES, reserveOf, usdOf } from './cost.ts'
import { VisionError } from './errors.ts'
import { FAKE_KEY, FakeProvider } from './testing/index.ts'
import type { CallOptions, ObserveInput, ProviderName, Sent } from './types.ts'

/**
 * Both adapters against the fake providers (SPEC §8.3, §12.0): what goes out, how an answer, a
 * refusal and a failure come back, and what the receipt gets of the sent body. No network.
 */

const fake = new FakeProvider()
beforeAll(() => fake.start())
afterAll(() => fake.stop())

const PIXEL = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')

const observe: ObserveInput = {
  stage: 'observe',
  type: 'PPV',
  duration_s: 804,
  frames: [
    { n: 1, t_s: 0, mime: 'image/webp', data: PIXEL },
    { n: 2, t_s: 4, mime: 'image/webp', data: PIXEL },
  ],
  vocabulary: ['lace', 'stockings'],
}

function call(sent: Sent[]): CallOptions {
  return {
    model: 'test-model',
    maxOutputTokens: 4000,
    timeoutMs: 5_000,
    onSent: (s) => sent.push(s),
  }
}

async function failure(promise: Promise<unknown>): Promise<VisionError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(VisionError)
  return error as VisionError
}

describe.each<ProviderName>(['openai', 'anthropic'])('%s adapter', (name) => {
  const provider = () => fake.provider(name)

  it('sends the frames with their numbers and reads the observations', async () => {
    const sent: Sent[] = []
    const result = await provider().observe(observe, call(sent))
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') return
    expect(result.output.observations.map((item) => item.n)).toEqual([1, 2])
    expect(result.usage).toEqual({ input_tokens: 1200, output_tokens: 300 })
    expect(result.requestId).toMatch(/^req_fake_/)
    const request = fake.of(name).at(-1)
    if (!request) throw new Error('no request')
    // The receipt's hash and size are of the bytes that arrived.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.bytes).toBe(request.raw.length)
    expect(sent[0]?.sha256.equals(createHash('sha256').update(request.raw).digest())).toBe(true)
    expect(request.context).toEqual({
      stage: 'observe',
      type: 'PPV',
      duration_s: 804,
      frames: [
        { n: 1, t_s: 0 },
        { n: 2, t_s: 4 },
      ],
      vocabulary: ['lace', 'stockings'],
    })
    const body = request.raw.toString('utf8')
    expect(body).toContain(PIXEL.toString('base64'))
    expect(body).toContain('Frame 2 at 4 s')
    if (name === 'openai') {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(request.json?.store).toBe(false)
      expect(body).toContain('"detail":"low"')
      expect(request.json?.text).toMatchObject({ format: { type: 'json_schema', strict: true } })
    } else {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(request.json?.output_config).toMatchObject({ format: { type: 'json_schema' } })
      // No server-side fallback to another model of the same provider (SPEC §8.3).
      expect(request.json).not.toHaveProperty('fallbacks')
    }
  })

  it('takes a refusal of the answer, of the policy and in words as a refusal', async () => {
    fake.next('refuse', 'policy_error', 'text_refusal')
    for (let i = 0; i < 3; i += 1) {
      const result = await provider().observe(observe, call([]))
      expect(result.kind, `outcome ${i}`).toBe('refused')
      if (result.kind === 'refused') expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it('names each failure: auth, limit, outage, broken answer, unknown outcome', async () => {
    fake.next('unauthorized')
    expect((await failure(provider().observe(observe, call([])))).kind).toBe('auth_rejected')
    fake.next('rate_limited')
    const limited = await failure(provider().observe(observe, call([])))
    expect(limited.kind).toBe('rate_limited')
    expect(limited.retryAfterMs).toBe(7_000)
    fake.next('server_error')
    expect((await failure(provider().observe(observe, call([])))).kind).toBe('transient')
    fake.next('broken')
    const broken = await failure(provider().observe(observe, call([])))
    expect(broken.kind).toBe('bad_response')
    expect(broken.usage).toEqual({ input_tokens: 1200, output_tokens: 300 })
    const sent: Sent[] = []
    fake.next('lost_answer')
    expect((await failure(provider().observe(observe, call(sent)))).kind).toBe('unknown_outcome')
    expect(sent).toHaveLength(1)
  })

  it('a connection that never opened is a failure without an answer, not an unknown one', async () => {
    const closed = new FakeProvider()
    await closed.start()
    const adapter = closed.provider(name)
    await closed.stop()
    expect((await failure(adapter.observe(observe, call([])))).kind).toBe('transient')
  })

  it('reserves at least what the answer costs', () => {
    const price = KNOWN_PRICES.anthropic['claude-opus-5-5']
    if (!price) throw new Error('no price')
    const reserve = reserveOf(name, observe, 4000, price)
    expect(reserve).toBeGreaterThan(usdOf({ input_tokens: 1200, output_tokens: 300 }, price))
    expect(usdOf({ input_tokens: 1_000_000, output_tokens: 0 }, price)).toBe(4)
  })
})
