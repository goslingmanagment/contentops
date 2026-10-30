// pnpm dev:server — PostgreSQL 18 in Docker, migrations, bootstrap with the example models,
// a fictional catalog of Лора and the server in watch mode on 127.0.0.1:3000. `pnpm dev`
// (Vite) proxies `/api` to it.
// Sign in as `dmitriy` with the password below. Data stays in the container between runs;
// `docker rm -f contentops-dev-pg` starts from scratch.
// `DEV_FAKE_SOURCE=1` also starts a fake Dropbox of Lora with generated media
// (`scripts/dev-source.ts`), turns its scan on and runs the `worker` role: «Приехало» fills
// by itself within seconds.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = new URL('../../..', import.meta.url).pathname
const CONTAINER = process.env.DEV_PG_CONTAINER ?? 'contentops-dev-pg'
const IMAGE = 'postgres:18.6'
const PORT = process.env.DEV_PG_PORT ?? '54329'
const OWNER_PASSWORD = process.env.CONTENTOPS_OWNER_PASSWORD ?? 'contentops-dev'
const url = (user, password) =>
  `postgres://${user}:${password}@127.0.0.1:${PORT}/contentops`

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function containerState() {
  try {
    return docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim()
  } catch {
    return 'missing'
  }
}

function psql(sql, database = 'postgres') {
  return docker('exec', CONTAINER, 'psql', '-U', 'postgres', '-d', database, '-qtAc', sql).trim()
}

async function waitReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      psql('SELECT 1')
      return
    } catch {
      await delay(500)
    }
  }
  throw new Error(`${CONTAINER} did not become ready`)
}

function node(script, args, env) {
  execFileSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
}

const state = containerState()
if (state === 'missing') {
  docker(
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-e',
    'POSTGRES_PASSWORD=dev',
    '-p',
    `127.0.0.1:${PORT}:5432`,
    IMAGE,
  )
} else if (state !== 'true') {
  docker('start', CONTAINER)
}
await waitReady()

// The host script's part (SPEC §12.1): both roles and the database owned by the migrate role.
for (const [role, password] of [
  ['contentops_migrate', 'dev-migrate'],
  ['contentops_app', 'dev-app'],
]) {
  if (psql(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`) !== '1') {
    psql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
  }
}
if (psql(`SELECT 1 FROM pg_database WHERE datname = 'contentops'`) !== '1') {
  psql('CREATE DATABASE contentops OWNER contentops_migrate')
}

const cli = join(ROOT, 'packages/db/src/cli.ts')
node(cli, ['migrate'], { DATABASE_URL: url('contentops_migrate', 'dev-migrate') })
node(cli, ['bootstrap', join(ROOT, 'packages/db/bootstrap.example.json')], {
  DATABASE_URL: url('contentops_app', 'dev-app'),
  CONTENTOPS_OWNER_PASSWORD: OWNER_PASSWORD,
})

const storage = process.env.DEV_STORAGE ?? join(tmpdir(), 'contentops-dev')
for (const dir of ['data', 'derived', 'tmp']) mkdirSync(join(storage, dir), { recursive: true })
const storageEnv = {
  DATA_ROOT: join(storage, 'data'),
  DERIVED_ROOT: join(storage, 'derived'),
  TMP_ROOT: join(storage, 'tmp'),
}

// FFmpeg on PATH: the catalog gets real test-pattern media and the media worker roles run
// next to web (thumbnails, previews, copies, downloads). `DEV_MEDIA=0` skips them.
const media = process.env.DEV_MEDIA !== '0' && hasFfmpeg()
function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A fictional catalog of Лора for the screens; a model with objects is left as it is.
execFileSync('pnpm', ['--filter', '@contentops/server', 'seed', 'lora', ...(media ? ['--media'] : [])], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ...storageEnv, DATABASE_URL: url('contentops_app', 'dev-app') },
})

const children = []
let sourceEnv = {}
if (process.env.DEV_FAKE_SOURCE === '1') {
  const source = spawn(process.execPath, [join(ROOT, 'apps/server/scripts/dev-source.ts')], {
    cwd: join(ROOT, 'apps/server'),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(source)
  const base = await new Promise((resolve, reject) => {
    source.stdout.on('data', (chunk) => {
      const ready = /ready (\S+)/.exec(String(chunk))
      if (ready) resolve(ready[1])
    })
    source.on('exit', () => reject(new Error('dev-source stopped')))
  })
  sourceEnv = {
    DROPBOX_REFRESH_TOKEN: 'dev-dropbox-token',
    DROPBOX_API_BASE: base,
    DROPBOX_CONTENT_BASE: base,
  }
  // The owner's switch «Скан по источнику» of Lora's Dropbox, journaled like a click.
  psql(
    `SELECT set_config('app.actor_type', 'system', false), set_config('app.actor_id', '', false),
            set_config('app.actor_label', 'dev-stack', false),
            set_config('app.action', 'admin.updateIntegration', false),
            set_config('app.request_id', gen_random_uuid()::text, false),
            set_config('app.item_id', '', false), set_config('app.work_id', '', false);
     INSERT INTO policy_settings (model_id, key, value)
     SELECT id, 'dropbox.scan', 'true'::jsonb FROM models WHERE code = 'lora'
     ON CONFLICT ON CONSTRAINT policy_settings_scope DO NOTHING`,
    'contentops',
  )
  console.log(`fake Dropbox of Lora at ${base}`)
}

const roleEnv = (role) => ({
  ...process.env,
  ...storageEnv,
  ...sourceEnv,
  ROLE: role,
  DATABASE_URL: url('contentops_app', 'dev-app'),
  PUBLIC_URL: 'http://localhost:5173',
  // No nginx in development: web streams previews and downloads itself.
  FILES_DIRECT: '1',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
})

console.log(`\nContentOps dev: http://localhost:5173 after \`pnpm dev\` · dmitriy / ${OWNER_PASSWORD}\n`)
// The scan of the fake source needs `worker` even without FFmpeg.
const roles = media
  ? ['worker', 'worker-video', 'worker-image']
  : process.env.DEV_FAKE_SOURCE === '1'
    ? ['worker']
    : []
children.unshift(
  spawn('pnpm', ['--filter', '@contentops/server', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: roleEnv('web'),
  }),
)
children.push(
  ...roles.map((role) =>
    spawn('pnpm', ['--filter', '@contentops/server', 'exec', 'tsx', 'src/main.ts'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: roleEnv(role),
    }),
  ),
)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal)
  })
}
children[0]?.on('exit', (code) => {
  for (const child of children.slice(1)) child.kill('SIGTERM')
  process.exit(code ?? 0)
})
