import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aliases } from './aliases'
import type { Io } from './io'
import { main } from './main'
import { findRoute, pathParams, queryKeys, tableEntries } from './table'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Answer = (request: Sent) => Response | Promise<Response>

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const PAGE = { items: [], next_cursor: null }
const OK = { ok: true }

function harness(
  answers: Answer | Answer[],
  options: { env?: Record<string, string | undefined>; stdin?: string; cwd?: string } = {},
) {
  const queue = Array.isArray(answers) ? [...answers] : null
  const sent: Sent[] = []
  const sleeps: number[] = []
  let clock = 0
  const state = { out: '', err: '' }
  const io: Io = {
    env: { CONTENTOPS_URL: 'http://co.test/', CONTENTOPS_TOKEN: 'secret-1', ...options.env },
    fetch: async (url, init) => {
      const request: Sent = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      }
      sent.push(request)
      const answer = queue ? queue.shift() : (answers as Answer)
      if (!answer) throw new Error(`no answer for ${request.method} ${url}`)
      return answer(request)
    },
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    readStdin: async () => options.stdin ?? '',
    cwd: options.cwd ?? process.cwd(),
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
  }
  return {
    sent,
    sleeps,
    run: (...argv: string[]) => main(argv, io),
    get out() {
      return state.out
    },
    get err() {
      return state.err
    },
  }
}

describe('arguments', () => {
  it('path params become the path, the token goes as Bearer, stdout is indented JSON', async () => {
    const cli = harness(() => json(200, PAGE))
    expect(await cli.run('objects', 'recent', '--model', 'lora')).toBe(0)
    expect(cli.sent).toEqual([
      expect.objectContaining({
        url: 'http://co.test/api/v1/lora/recent',
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer secret-1' }),
      }),
    ])
    expect(cli.sent[0]?.headers['idempotency-key']).toBeUndefined()
    expect(cli.out).toBe(`${JSON.stringify(PAGE, null, 2)}\n`)
    expect(cli.err).toBe('')
  })

  it('query keys may repeat; --json prints one line; area.name works as one word', async () => {
    const cli = harness(() => json(200, PAGE))
    const code = await cli.run(
      'objects.list',
      '--model=lora',
      '--tag',
      'lace',
      '--tag',
      'dance',
      '--limit',
      '10',
      '--json',
    )
    expect(code).toBe(0)
    expect(cli.sent[0]?.url).toBe('http://co.test/api/v1/lora/items?tag=lace&tag=dance&limit=10')
    expect(cli.out).toBe(`${JSON.stringify(PAGE)}\n`)
  })

  it.each([
    [['objects', 'recent', '--model', 'lora', '--nope', '1'], /unknown flag --nope/],
    [['objects', 'get', '--model', 'lora'], /needs --id/],
    [['objects', 'recent', '--model', 'lora', '--model', 'ari'], /more than once/],
    [['objects', 'recent', '--model'], /needs a value/],
    [['objects', 'recent', '--model', '--json'], /--model needs a value/],
    [['objects', 'nothing'], /unknown command objects.nothing/],
    [['objects'], /name the route: contentops objects </],
    [['objects', 'recent', 'extra'], /unexpected argument extra/],
    [['settings', 'revokeAccess', '--person', 'p1', '--body', '{}'], /takes no body/],
    [['objects', 'alreadyUploaded', '--model', 'lora'], /needs --body/],
    [['objects', 'alreadyUploaded', '--model', 'lora', '--body', '{oops'], /--body is not JSON/],
    [['objects', 'recent', '--model', 'lora', '--if-match', 'v1'], /--if-match must be/],
    [['objects', 'recent', '--model', 'lora', '--timeout', '5'], /--timeout goes with --wait/],
    [['media', 'download', '--model', 'lora', '--receipt', 'r1'], /--out <path>/],
  ])('usage error %j → 64, nothing sent', async (argv, message) => {
    const cli = harness(() => json(200, PAGE))
    expect(await cli.run(...argv)).toBe(64)
    expect(cli.err).toMatch(message)
    expect(cli.sent).toEqual([])
    expect(cli.out).toBe('')
  })

  it('takes the body inline, from a file relative to cwd and from stdin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentops-cli-'))
    await writeFile(join(dir, 'body.json'), '{"items":[{"id":"PPV-001"}]}')
    const answer = () => json(200, { results: [] })
    const inline = harness(answer)
    await inline.run('objects', 'alreadyUploaded', '--model', 'lora', '--body', '{"a":1}')
    const file = harness(answer, { cwd: dir })
    await file.run('objects', 'alreadyUploaded', '--model', 'lora', '--body', '@body.json')
    const stdin = harness(answer, { stdin: '{"from":"stdin"}' })
    await stdin.run('objects', 'alreadyUploaded', '--model', 'lora', '--body', '-')
    expect(inline.sent[0]?.body).toEqual({ a: 1 })
    expect(file.sent[0]?.body).toEqual({ items: [{ id: 'PPV-001' }] })
    expect(stdin.sent[0]?.body).toEqual({ from: 'stdin' })
    expect(file.sent[0]?.headers['content-type']).toBe('application/json')
  })

  it('a missing body file is a usage error', async () => {
    const cli = harness(() => json(200, OK))
    const code = await cli.run(
      'objects',
      'alreadyUploaded',
      '--model',
      'lora',
      '--body',
      '@no.json',
    )
    expect(code).toBe(64)
    expect(cli.err).toMatch(/cannot read .*no\.json/)
  })

  it('saves a file answer to --out and prints where', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentops-cli-'))
    const cli = harness(() => new Response('bytes', { headers: { 'content-type': 'video/mp4' } }), {
      cwd: dir,
    })
    const argv = ['media', 'download', '--model', 'lora', '--receipt', 'r1', '--out', 'a.mp4']
    expect(await cli.run(...argv, '--json')).toBe(0)
    expect(cli.sent[0]?.url).toBe('http://co.test/api/v1/lora/downloads/r1')
    expect(await readFile(join(dir, 'a.mp4'), 'utf8')).toBe('bytes')
    expect(JSON.parse(cli.out)).toEqual({
      file: join(dir, 'a.mp4'),
      size_bytes: 5,
      content_type: 'video/mp4',
    })
  })

  it('no route parameter or query key is taken by a global option', () => {
    const globals = [
      'body',
      'json',
      'wait',
      'timeout',
      'help',
      'if-match',
      'idempotency-key',
      'out',
    ]
    for (const { key, route } of tableEntries()) {
      const taken = [...pathParams(route), ...queryKeys(route)].filter((n) => globals.includes(n))
      expect(taken, key).toEqual([])
    }
  })
})

describe('errors and exit codes', () => {
  const body = { code: 'not_found', message: 'Такого объекта нет', request_id: 'req-1' }

  it('an API error: --json puts its body on stdout, stderr always gets code: message', async () => {
    const withJson = harness(() => json(404, body))
    expect(await withJson.run('objects', 'recent', '--model', 'lora', '--json')).toBe(1)
    expect(JSON.parse(withJson.out)).toEqual(body)
    expect(withJson.err).toBe('not_found: Такого объекта нет\n')
    const plain = harness(() => json(404, body))
    expect(await plain.run('objects', 'recent', '--model', 'lora')).toBe(1)
    expect(plain.out).toBe('')
    expect(plain.err).toBe('not_found: Такого объекта нет\n')
  })

  it.each([
    [400, 'invalid_request', 1],
    [409, 'idempotency_conflict', 1],
    [412, 'version_mismatch', 1],
    [422, 'row_marked', 1],
    [428, 'precondition_required', 1],
    [429, 'rate_limited', 1],
    [401, 'unauthenticated', 2],
    [403, 'forbidden', 2],
    [500, 'internal', 2],
    [503, 'unavailable', 2],
  ])('%i → exit %s', async (status, code, exit) => {
    const cli = harness(() => json(status, { code, message: 'm', request_id: 'r' }))
    expect(await cli.run('objects', 'recent', '--model', 'lora')).toBe(exit)
    expect(cli.err).toContain(`${code}: m`)
  })

  it('shows Retry-After of 429', async () => {
    const cli = harness(() =>
      json(
        429,
        { code: 'rate_limited', message: 'Лимит', request_id: 'r' },
        { 'retry-after': '30' },
      ),
    )
    expect(await cli.run('objects', 'recent', '--model', 'lora')).toBe(1)
    expect(cli.err).toBe('rate_limited: Лимит (retry after 30 s)\n')
  })

  it('a network failure is exit 2', async () => {
    const cli = harness(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    })
    expect(await cli.run('objects', 'recent', '--model', 'lora', '--json')).toBe(2)
    expect(cli.out).toBe('')
    expect(cli.err).toBe('connection: fetch failed (connect ECONNREFUSED)\n')
  })

  it('an answer outside the contract is exit 2', async () => {
    const cli = harness(() => json(200, { ok: false }))
    expect(await cli.run('settings', 'revokeAccess', '--person', 'p1')).toBe(2)
    expect(cli.err).toMatch(/does not match the contract/)
  })

  it('without a token it warns and sends no Authorization', async () => {
    const cli = harness(
      () => json(401, { code: 'unauthenticated', message: 'Нет', request_id: 'r' }),
      {
        env: { CONTENTOPS_TOKEN: undefined },
      },
    )
    expect(await cli.run('objects', 'recent', '--model', 'lora')).toBe(2)
    expect(cli.sent[0]?.headers.authorization).toBeUndefined()
    expect(cli.err).toBe('warning: CONTENTOPS_TOKEN is not set\nunauthenticated: Нет\n')
  })
})

describe('idempotency and versions', () => {
  it('a change gets a new key per run, printed to stderr and sent as Idempotency-Key', async () => {
    const cli = harness(() => json(200, OK))
    await cli.run('settings', 'revokeAccess', '--person', 'p1')
    await cli.run('settings', 'revokeAccess', '--person', 'p1')
    const keys = cli.sent.map((request) => request.headers['idempotency-key'])
    expect(keys[0]).toMatch(/^[\w-]{16,}$/)
    expect(keys[1]).not.toBe(keys[0])
    expect(cli.err).toBe(`idempotency-key: ${keys[0]}\nidempotency-key: ${keys[1]}\n`)
    expect(cli.sent[0]).toMatchObject({
      method: 'POST',
      url: 'http://co.test/api/v1/admin/people/p1:revoke-access',
    })
  })

  it('--idempotency-key repeats an intent; --if-match sends the version', async () => {
    const cli = harness(() => json(200, OK))
    const argv = ['settings', 'revokeAccess', '--person', 'p1', '--idempotency-key', 'k-1']
    await cli.run(...argv, '--if-match', '7')
    expect(cli.sent[0]?.headers).toMatchObject({ 'idempotency-key': 'k-1', 'if-match': '"7"' })
    expect(cli.err).toBe('idempotency-key: k-1\n')
  })

  it('sign-in carries no key', async () => {
    const cli = harness(() =>
      json(401, { code: 'unauthenticated', message: 'Нет', request_id: 'r' }),
    )
    await cli.run('auth', 'signIn', '--body', '{"login":"x","password":"y"}')
    expect(cli.sent[0]?.headers['idempotency-key']).toBeUndefined()
    expect(cli.err).not.toContain('idempotency-key')
  })
})

describe('--wait', () => {
  const accepted = {
    kind: 'operation',
    operation_id: 'op-1',
    status_url: '/api/v1/admin/operations/op-1',
  }
  const operation = (state: 'running' | 'done' | 'failed', progress: number, extra = {}) => ({
    id: 'op-1',
    kind: 'verify_blobs',
    label: 'Проверка хранилища',
    state,
    progress,
    created_at: '2026-10-30T10:00:00Z',
    finished_at: state === 'running' ? null : '2026-10-30T10:01:00Z',
    result: null,
    error: null,
    ...extra,
  })

  it('without --wait a 202 is exit 0 with the operation on stdout and a hint on stderr', async () => {
    const cli = harness(() => json(202, accepted))
    expect(await cli.run('admin', 'verifyBlobs', '--json')).toBe(0)
    expect(JSON.parse(cli.out)).toEqual(accepted)
    expect(cli.err).toMatch(/accepted: operation op-1 .*--wait/)
  })

  it('polls the status address with a growing pause until done', async () => {
    const cli = harness([
      () => json(202, accepted),
      () => json(200, operation('running', 0.1)),
      () => json(200, operation('running', 0.1)),
      () =>
        json(429, { code: 'rate_limited', message: 'm', request_id: 'r' }, { 'retry-after': '3' }),
      () => json(200, operation('running', 0.6)),
      () => json(200, operation('done', 1)),
    ])
    expect(await cli.run('admin', 'verifyBlobs', '--wait', '--json')).toBe(0)
    expect(cli.sent.slice(1).map((request) => request.url)).toEqual(
      Array(5).fill('http://co.test/api/v1/admin/operations/op-1'),
    )
    expect(cli.sleeps).toEqual([500, 750, 3000, 1687.5])
    expect(JSON.parse(cli.out)).toEqual(operation('done', 1))
    expect(cli.err.split('\n').filter((line) => line.startsWith('operation'))).toEqual([
      'operation op-1: Проверка хранилища · 10%',
      'operation op-1: Проверка хранилища · 60%',
      'operation op-1: Проверка хранилища · 100%',
    ])
  })

  it('a failed operation is exit 1 with its error', async () => {
    const error = { code: 'internal', message: 'Не собралось', request_id: 'r-2' }
    const cli = harness([
      () => json(202, { ...accepted, status_url: '/api/v1/lora/operations/op-1' }),
      () => json(200, operation('failed', 0.5, { error })),
    ])
    expect(await cli.run('admin', 'verifyBlobs', '--wait')).toBe(1)
    expect(cli.sent[1]?.url).toBe('http://co.test/api/v1/lora/operations/op-1')
    expect(JSON.parse(cli.out).error).toEqual(error)
    expect(cli.err).toContain('internal: Не собралось\n')
  })

  it('on a status route follows an operation started earlier', async () => {
    const cli = harness([
      () => json(200, operation('running', 0.5)),
      () => json(200, operation('done', 1)),
    ])
    const argv = ['operations', 'get', '--model', 'lora', '--operation', 'op-1', '--wait', '--json']
    expect(await cli.run(...argv)).toBe(0)
    expect(cli.sent.map((request) => request.url)).toEqual(
      Array(2).fill('http://co.test/api/v1/lora/operations/op-1'),
    )
    expect(JSON.parse(cli.out).state).toBe('done')
  })

  it('gives up after --timeout with exit 2 and how to follow the operation', async () => {
    const cli = harness((request) =>
      request.method === 'POST' ? json(202, accepted) : json(200, operation('running', 0.2)),
    )
    expect(await cli.run('admin', 'verifyBlobs', '--wait', '--timeout', '2')).toBe(2)
    expect(cli.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(2000)
    expect(JSON.parse(cli.out).state).toBe('running')
    expect(cli.err).toContain('contentops admin operation --operation op-1 --wait')
  })
})

describe('aliases', () => {
  it('orders find --tg: the card link in any spelling becomes the order address', async () => {
    const cli = harness(() => json(404, { code: 'not_found', message: 'Нет', request_id: 'r' }))
    const link = 'https://t.me/c/2627984998/12/9844'
    expect(await cli.run('orders', 'find', '--model', 'lora', '--tg', link)).toBe(1)
    expect(
      await cli.run('orders', 'find', '--model', 'lora', '--tg', 'tg:-1002627984998/12/9844'),
    ).toBe(1)
    expect(cli.sent.map((request) => request.url)).toEqual([
      'http://co.test/api/v1/lora/orders/tg-2627984998-12-9844',
      'http://co.test/api/v1/lora/orders/tg-2627984998-12-9844',
    ])
    expect(await cli.run('orders', 'find', '--model', 'lora', '--tg', 'не ссылка')).toBe(64)
  })

  it('turn their flags into the flags of a route', async () => {
    const cli = harness(() => json(404, { code: 'not_found', message: 'Нет', request_id: 'r' }))
    const link = 'http://localhost:5173/#/lora/i/PPV-073'
    expect(await cli.run('objects', 'open', '--link', link)).toBe(1)
    expect(cli.sent[0]?.url).toBe('http://co.test/api/v1/lora/i/PPV-073')
  })

  it('refuse flags they do not declare and links they cannot read', async () => {
    const cli = harness(() => json(200, OK))
    expect(await cli.run('objects', 'open', '--link', 'x', '--id', 'PPV-1')).toBe(64)
    expect(await cli.run('objects', 'open', '--link', 'http://x/#/lora/plan')).toBe(64)
    expect(cli.sent).toEqual([])
  })

  it('call existing routes and never shadow one', () => {
    for (const [key, alias] of Object.entries(aliases)) {
      expect(findRoute(key), key).toBeUndefined()
      expect(findRoute(alias.route), alias.route).toBeDefined()
    }
  })
})

describe('help', () => {
  it('routes --json lists every route and alias', async () => {
    const cli = harness(() => json(200, OK))
    expect(await cli.run('routes', '--json')).toBe(0)
    const listed = JSON.parse(cli.out)
    expect(listed.routes).toContainEqual({
      route: 'objects.get',
      method: 'GET',
      path: '/api/v1/{model}/i/{id}',
    })
    expect(listed.routes).toHaveLength(tableEntries().length)
    expect(listed.aliases.map((alias: { alias: string }) => alias.alias)).toContain('objects.open')
  })

  it('a route --help gives params, query keys and the body JSON Schema', async () => {
    const cli = harness(() => json(200, OK))
    expect(await cli.run('objects', 'list', '--help', '--json')).toBe(0)
    const help = JSON.parse(cli.out)
    expect(help).toMatchObject({ route: 'objects.list', params: ['model'], body: null })
    expect(Object.keys(help.query.properties)).toEqual([
      'cursor',
      'limit',
      'type',
      'where',
      'kind',
      'tag',
    ])
    const post = harness(() => json(200, OK))
    await post.run('help', 'objects', 'alreadyUploaded')
    expect(post.out).toContain('body (JSON Schema):')
    expect(post.sent).toEqual([])
  })
})
