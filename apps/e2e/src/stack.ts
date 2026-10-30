// The whole stack for the browser scenarios (SPEC §12.0 «Тесты»): PostgreSQL 18 in a
// throwaway container, migrations as the schema owner, bootstrap with the example models,
// the catalog of Лора with real generated media and a week of its plan (`seed lora --media
// --plan`: the content manager Диана), then the server roles — `web` and the three workers
// that build thumbnails, previews, copies and ZIPs. Playwright starts it as a web server and
// waits for `/healthz`; the interface is the production build behind `vite preview`, which
// proxies `/api` here as nginx does in the stack. Every integration is off and no secret is
// set: the scenario «всё выключено» (PLAN 1а) is the default of this stack.
//
// `pnpm --filter @contentops/e2e stack` runs it by hand; Playwright then reuses it outside CI.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, databaseUrl, startPostgres } from '@contentops/db/testing/postgres'
import { E2E } from './env.ts'

const ROOT = new URL('../../..', import.meta.url).pathname
const HERE = new URL('..', import.meta.url).pathname
const LOGS = join(HERE, '.stack')
const DATABASE = 'contentops'

function hasFfmpeg(): boolean {
  try {
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-version'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

if (!hasFfmpeg()) {
  // Thumbnails, previews, copies and the promo ZIP are part of the scenarios.
  console.error('e2e stack: FFmpeg with SVT-AV1 is needed on PATH (or FFMPEG_PATH)')
  process.exit(2)
}

rmSync(LOGS, { recursive: true, force: true })
mkdirSync(LOGS, { recursive: true })
const started = Date.now()
const step = (text: string) =>
  console.log(`e2e stack: ${text} (${((Date.now() - started) / 1000).toFixed(1)} s)`)

const { info, container } = await startPostgres()
await createDatabase(info, DATABASE)
step(`PostgreSQL on ${info.host}:${info.port}`)

const storage = mkdtempSync(join(tmpdir(), 'contentops-e2e-'))
const storageEnv = {
  DATA_ROOT: join(storage, 'data'),
  DERIVED_ROOT: join(storage, 'derived'),
  TMP_ROOT: join(storage, 'tmp'),
}
for (const dir of Object.values(storageEnv)) mkdirSync(dir, { recursive: true })

const appUrl = databaseUrl(info, DATABASE, 'app')
const run = (command: string, args: string[], env: Record<string, string>) =>
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  })

const cli = join(ROOT, 'packages/db/src/cli.ts')
run(process.execPath, [cli, 'migrate'], { DATABASE_URL: databaseUrl(info, DATABASE, 'migrate') })
run(process.execPath, [cli, 'bootstrap', join(ROOT, 'packages/db/bootstrap.example.json')], {
  DATABASE_URL: appUrl,
  CONTENTOPS_OWNER_PASSWORD: E2E.password,
})
step('migrated and bootstrapped')
run('pnpm', ['--filter', '@contentops/server', 'seed', 'lora', '--media', '--plan'], {
  ...storageEnv,
  DATABASE_URL: appUrl,
  CONTENTOPS_OWNER_PASSWORD: E2E.password,
})
step('seeded')

// What the scenarios read besides the browser: the database for checks no screen shows.
writeFileSync(join(LOGS, 'stack.json'), JSON.stringify({ databaseUrl: appUrl, storage }, null, 2))

const children: ChildProcess[] = []
const roleEnv = (role: string) => ({
  ...process.env,
  ...storageEnv,
  ROLE: role,
  HOST: '127.0.0.1',
  PORT: String(E2E.serverPort),
  DATABASE_URL: appUrl,
  PUBLIC_URL: E2E.baseUrl,
  // No nginx: `web` streams previews and downloads itself.
  FILES_DIRECT: '1',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
})
for (const role of ['web', 'worker', 'worker-video', 'worker-image']) {
  const log = createWriteStream(join(LOGS, `${role}.log`))
  const child = spawn('pnpm', ['--filter', '@contentops/server', 'exec', 'tsx', 'src/main.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: roleEnv(role),
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`e2e stack: ${role} stopped (${code ?? signal}), see ${LOGS}/${role}.log`)
      void stop(1)
    }
  })
  children.push(child)
}
step(`server roles started, web on 127.0.0.1:${E2E.serverPort}`)

let stopping = false
async function stop(code: number) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  await container.stop().catch(() => {})
  rmSync(storage, { recursive: true, force: true })
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop(0))
