import { execFileSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type APIRequestContext,
  type BrowserContext,
  test as base,
  expect,
  type Page,
  request,
} from '@playwright/test'
import pg from 'pg'
import { E2E } from './env.ts'

/**
 * People of the scenarios. `owner` — Дмитрий, `km` — the content manager Диана of Лора (seed
 * `--plan`), `reader` — «Только чтение» on Лора, `stranger` — a content manager of Ари only.
 * The setup project (`auth.setup.ts`) signs everyone in and keeps their cookies here.
 */
export type Who = 'owner' | 'km' | 'reader' | 'stranger'
export const WHO: readonly Who[] = ['owner', 'km', 'reader', 'stranger']

export const AUTH_DIR = new URL('../.auth/', import.meta.url).pathname
export const statePath = (who: Who) => join(AUTH_DIR, `${who}.json`)

/** Logins and passwords of the people the setup created (`people.json`). */
export interface Person {
  login: string
  password: string
  name: string
}
export function people(): Record<Who, Person> {
  return JSON.parse(readFileSync(join(AUTH_DIR, 'people.json'), 'utf8'))
}

/** The stack's own facts (`stack.ts`): the database for checks that no screen shows. */
function stackInfo(): { databaseUrl: string } {
  return JSON.parse(readFileSync(new URL('../.stack/stack.json', import.meta.url), 'utf8'))
}

/** A JSON API of one person: commands carry an `Idempotency-Key`, versioned ones `If-Match`. */
export class Api {
  readonly context: APIRequestContext

  constructor(context: APIRequestContext) {
    this.context = context
  }

  async get<T = unknown>(path: string): Promise<T> {
    const response = await this.context.get(path)
    expect(response.status(), `GET ${path}: ${await response.text()}`).toBeLessThan(300)
    return (await response.json()) as T
  }

  async send<T = unknown>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    version?: number,
  ): Promise<T> {
    const response = await this.context.fetch(path, {
      method,
      headers: {
        'idempotency-key': randomUUID(),
        ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
      },
      ...(body === undefined ? {} : { data: body }),
    })
    expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300)
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body)
  }
}

export async function apiAs(who: Who): Promise<Api> {
  return new Api(await request.newContext({ baseURL: E2E.baseUrl, storageState: statePath(who) }))
}

/**
 * A file to upload, drawn by FFmpeg (no people, as the seed): Conway's life from a random seed,
 * so every file has its own bytes and its own perceptual hash — no «похоже на …» between runs.
 */
export function makeMedia(kind: 'photo' | 'video', name?: string, seconds = 3): string {
  const dir = mkdtempSync(join(tmpdir(), 'contentops-e2e-media-'))
  const seed = randomInt(1, 2 ** 31)
  const file = join(dir, name ?? (kind === 'photo' ? `photo-${seed}.jpg` : `clip-${seed}.mp4`))
  const life = `life=size=270x480:rate=30:seed=${seed}:ratio=0.3:mold=8:life_color=#e07050:death_color=#203040,scale=1080:1920:flags=neighbor`
  const args =
    kind === 'photo'
      ? ['-f', 'lavfi', '-i', life, '-frames:v', '1', '-q:v', '3', file]
      : [
          ['-f', 'lavfi', '-i', life],
          ['-f', 'lavfi', '-i', `sine=frequency=${200 + (seed % 400)}:sample_rate=48000`],
          ['-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'],
          ['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', file],
        ].flat()
  execFileSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args],
    { stdio: 'inherit' },
  )
  return file
}

/** Today by Moscow, `YYYY-MM-DD`: the plan lives by real time. */
export function mskToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
}

/** A read-only query to the database of the stack (no screen shows what is checked). */
export async function dbQuery<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: stackInfo().databaseUrl })
  await client.connect()
  try {
    return (await client.query<T>(text, values)).rows
  } finally {
    await client.end()
  }
}

interface Fixtures {
  /** A page of the owner Дмитрий. */
  owner: Page
  /** A page of the content manager Диана (Лора). */
  km: Page
  /** A page of a person with «Только чтение» on Лора. */
  reader: Page
  /** A page of a content manager of Ари only. */
  stranger: Page
  /** The owner's API for preparing what a scenario does not click through. */
  ownerApi: Api
}

async function pageOf(
  newContext: (options: { storageState: string }) => Promise<BrowserContext>,
  who: Who,
  use: (page: Page) => Promise<void>,
) {
  const context = await newContext({ storageState: statePath(who) })
  const page = await context.newPage()
  await use(page)
  await context.close()
}

export const test = base.extend<Fixtures>({
  owner: async ({ browser }, use) => pageOf((o) => browser.newContext(o), 'owner', use),
  km: async ({ browser }, use) => pageOf((o) => browser.newContext(o), 'km', use),
  reader: async ({ browser }, use) => pageOf((o) => browser.newContext(o), 'reader', use),
  stranger: async ({ browser }, use) => pageOf((o) => browser.newContext(o), 'stranger', use),
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the needed fixtures from it
  ownerApi: async ({}, use) => {
    const api = await apiAs('owner')
    await use(api)
    await api.context.dispose()
  },
})

export { expect }
