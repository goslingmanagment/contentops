// pnpm perf:stack — the stand of the interface measurement (PLAN 4 «Скорость и плавность»,
// SPEC §12.0, DESIGN §9.3): its own PostgreSQL 18 in Docker (`contentops-perf-pg`, never the
// dev or the pilot's base), migrations, bootstrap with the example models, the full-volume
// catalog of Лора (`seed lora --media --full`: 1 391 objects, placements, covers drawn by FFmpeg
// and sharp), the worker roles once for the covers, then the production builds: the server
// bundle (`dist/main.js`, role `web`) and the interface behind nginx of the stack with the
// config of `ops/nginx/contentops.conf` (only `web` points at the host).
//
// Interface: http://localhost:8180 · dmitriy / contentops-perf. Stays up until Ctrl-C;
// `pnpm perf` measures against it. `docker rm -f contentops-perf-pg` starts from scratch.
// Needs Docker and FFmpeg on PATH.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = new URL('../..', import.meta.url).pathname
const PG = 'contentops-perf-pg'
const PROXY = 'contentops-perf-proxy'
const NETWORK = 'contentops-perf'
const PG_PORT = process.env.PERF_PG_PORT ?? '54339'
const WEB_PORT = process.env.PERF_WEB_PORT ?? '3180'
const PROXY_PORT = process.env.PERF_PORT ?? '8180'
const OWNER_PASSWORD = 'contentops-perf'
const STORAGE = process.env.PERF_STORAGE ?? join(tmpdir(), 'contentops-perf')
const url = (user, password) => `postgres://${user}:${password}@127.0.0.1:${PG_PORT}/contentops`
const APP_URL = url('contentops_app', 'perf-app')

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

const docker = (...args) => run('docker', args)

function state(name) {
  try {
    return docker('inspect', '-f', '{{.State.Running}}', name).trim()
  } catch {
    return 'missing'
  }
}

function psql(sql, database = 'postgres') {
  return docker('exec', PG, 'psql', '-U', 'postgres', '-d', database, '-qtAc', sql).trim()
}

async function until(check, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      if (await check()) return
    } catch {}
    await delay(1000)
  }
  throw new Error(`${what}: no answer`)
}

// 1. Its own database.
if (state(PG) === 'missing') {
  docker(
    'run',
    '-d',
    '--name',
    PG,
    '-e',
    'POSTGRES_PASSWORD=perf',
    '-p',
    `127.0.0.1:${PG_PORT}:5432`,
    'postgres:18.6',
  )
} else if (state(PG) !== 'true') {
  docker('start', PG)
}
await until(() => psql('SELECT 1') === '1', PG)
for (const [role, password] of [
  ['contentops_migrate', 'perf-migrate'],
  ['contentops_app', 'perf-app'],
]) {
  if (psql(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`) !== '1') {
    psql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
  }
}
if (psql(`SELECT 1 FROM pg_database WHERE datname = 'contentops'`) !== '1') {
  psql('CREATE DATABASE contentops OWNER contentops_migrate')
}
const cli = join(ROOT, 'packages/db/src/cli.ts')
const inherit = { stdio: 'inherit', cwd: ROOT }
run(process.execPath, [cli, 'migrate'], {
  ...inherit,
  env: { ...process.env, DATABASE_URL: url('contentops_migrate', 'perf-migrate') },
})
run(process.execPath, [cli, 'bootstrap', join(ROOT, 'packages/db/bootstrap.example.json')], {
  ...inherit,
  env: { ...process.env, DATABASE_URL: APP_URL, CONTENTOPS_OWNER_PASSWORD: OWNER_PASSWORD },
})

// 2. The catalog and its covers.
for (const dir of ['data', 'derived', 'tmp']) mkdirSync(join(STORAGE, dir), { recursive: true })
const storageEnv = {
  DATA_ROOT: join(STORAGE, 'data'),
  DERIVED_ROOT: join(STORAGE, 'derived'),
  TMP_ROOT: join(STORAGE, 'tmp'),
}
const serverEnv = (role) => ({
  ...process.env,
  ...storageEnv,
  ROLE: role,
  NODE_ENV: 'production',
  DATABASE_URL: APP_URL,
  PUBLIC_URL: `http://localhost:${PROXY_PORT}`,
  HOST: '127.0.0.1',
  PORT: WEB_PORT,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
})
run('pnpm', ['--filter', '@contentops/server', 'seed', 'lora', '--media', '--full'], {
  ...inherit,
  env: { ...process.env, ...storageEnv, DATABASE_URL: APP_URL },
})
const pendingDerive = () =>
  Number(
    psql(
      `SELECT count(*) FROM work_operations WHERE kind IN ('derive_video', 'derive_image')
          AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
      'contentops',
    ),
  )
if (pendingDerive() > 0) {
  console.log('perf: covers are being drawn by the worker roles…')
  const workers = ['worker-video', 'worker-image'].map((role) =>
    spawn('pnpm', ['--filter', '@contentops/server', 'exec', 'tsx', 'src/main.ts'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...serverEnv(role), NODE_ENV: 'development' },
    }),
  )
  await until(() => pendingDerive() === 0, 'covers', 900)
  for (const worker of workers) worker.kill('SIGTERM')
}

// 3. Production builds.
run('pnpm', ['--filter', '@contentops/web', 'build'], inherit)
run('pnpm', ['--filter', '@contentops/server', 'build'], inherit)

// 4. `web` from the bundle and nginx of the stack in front of it.
const web = spawn(process.execPath, [join(ROOT, 'apps/server/dist/main.js')], {
  cwd: join(ROOT, 'apps/server'),
  stdio: 'inherit',
  env: serverEnv('web'),
})
await until(async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`)).status < 500, 'web')

try {
  docker('network', 'inspect', NETWORK)
} catch {
  docker('network', 'create', NETWORK)
}
// `web` runs on the host, not next to nginx: Docker Desktop's way from a container to the host
// added about 200 ms to every twentieth new connection (30.10.2026), so here the connections
// to `web` stay open. In the stack nginx and `web` share a Docker network and do not need it.
const source = readFileSync(join(ROOT, 'ops/nginx/contentops.conf'), 'utf8')
const conf = `upstream perf_web {\n  server host.docker.internal:${WEB_PORT};\n  keepalive 16;\n}\n\n${source
  .replace('set $web http://web:3000;', 'set $web http://perf_web;')
  .replace(
    '    proxy_set_header X-Request-Id $request_id_out;\n',
    '    proxy_set_header X-Request-Id $request_id_out;\n    proxy_set_header Connection "";\n',
  )}`
if (!conf.includes('http://perf_web;') || !conf.includes('Connection ""')) {
  throw new Error('ops/nginx/contentops.conf changed: update tools/perf/stack.mjs')
}
const confFile = join(STORAGE, 'nginx.conf')
writeFileSync(confFile, conf)
if (state(PROXY) !== 'missing') docker('rm', '-f', PROXY)
docker(
  'run',
  '-d',
  '--name',
  PROXY,
  '--network',
  NETWORK,
  '-p',
  `127.0.0.1:${PROXY_PORT}:8080`,
  '-v',
  `${confFile}:/etc/nginx/conf.d/default.conf:ro`,
  '-v',
  `${join(ROOT, 'apps/web/dist')}:/usr/share/nginx/html:ro`,
  '-v',
  `${storageEnv.DATA_ROOT}:/srv/content:ro`,
  '-v',
  `${storageEnv.DERIVED_ROOT}:/srv/derived:ro`,
  '-v',
  `${storageEnv.TMP_ROOT}:/srv/tmp:ro`,
  'nginx:1.30.6-alpine',
)
await until(async () => (await fetch(`http://localhost:${PROXY_PORT}/healthz`)).ok, 'nginx')
console.log(`\nperf stand: http://localhost:${PROXY_PORT} · dmitriy / ${OWNER_PASSWORD}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    web.kill(signal)
    try {
      docker('rm', '-f', PROXY)
    } catch {}
    process.exit(0)
  })
}
web.on('exit', (code) => process.exit(code ?? 0))
