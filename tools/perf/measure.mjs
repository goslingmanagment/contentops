// pnpm perf [-- options] — the interface measurement of SPEC §12.0 «Внешний вид и поведение
// интерфейса» (PLAN 4, DESIGN §9.1, §9.3) against the stand of `pnpm perf:stack`: the
// production build behind nginx on the full-volume generated catalog of Лора.
//
// Four scenarios, each run N times in Chrome (Playwright, headless by default, 1440 × 800):
//   search  `/` and «кружево» typed in the top search, 120 ms between keys
//   scroll  the FYP grid (796) to the end by a synthetic wheel gesture at 8 000 px/s
//   open    double click on a PPV tile → its card (PPV-073 first, then its neighbours, each once)
//   select  `Ctrl/⌘ A` in FYP with the chip «Где залито: Fansly 2 · нет»
// Two quantities: response latency (input → the frame that shows the answer, measured in the
// page: event time → requestAnimationFrame → the task after that frame) and dropped frames
// (gaps between animation frames: a gap of k × 16.7 ms drops k − 1 frames; also gaps over
// 33 ms, long tasks and frames where the grid's visible rows were not rendered yet).
// Conditions: `idle`, and `encoding` — two SVT-AV1 encodes of a generated 4K clip with the
// master profile (SPEC §9.2: preset 6, CRF 24, tune 1, qm, 10 bit, GOP 300, lp 4), each under
// `nice 10` like `worker-video` (ENCODE_JOBS=2); `throttle4` — Chrome's CPU slowed 4× (the
// prototype's draft condition, a weaker laptop).
//
// Options: --runs N (20) · --conditions idle,encoding · --scenarios search,scroll,open,select
//          --headed · --dpr 2 · --url http://localhost:8180 · --out results.json
// Needs Google Chrome (Playwright channel `chrome`) and FFmpeg with libsvtav1 on PATH.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values: opts } = parseArgs({
  options: {
    runs: { type: 'string', default: '20' },
    conditions: { type: 'string', default: 'idle,encoding' },
    scenarios: { type: 'string', default: 'search,scroll,open,select' },
    headed: { type: 'boolean', default: false },
    dpr: { type: 'string', default: '2' },
    url: { type: 'string', default: `http://localhost:${process.env.PERF_PORT ?? '8180'}` },
    out: { type: 'string' },
    login: { type: 'string', default: 'dmitriy' },
    password: { type: 'string', default: 'contentops-perf' },
  },
})
const RUNS = Number(opts.runs)
const BASE = opts.url
const STORAGE = process.env.PERF_STORAGE ?? join(tmpdir(), 'contentops-perf')
const FRAME = 1000 / 60

// ——— In the page: frames, long tasks, inputs and «the frame after» ———
function instrument() {
  const P = {
    frames: [],
    longtasks: [],
    loafs: [],
    events: [],
    inputs: [],
    blank: [],
    grid: null,
  }
  window.__perf = P
  const afterFrame = (callback) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => callback(performance.now())
      channel.port2.postMessage(0)
    })
  P.afterFrame = afterFrame
  const loop = (time) => {
    P.frames.push(time)
    const grid = P.grid
    if (grid?.isConnected) {
      // Are the rows that the scroll position shows rendered (virtual window)?
      const top = grid.scrollTop
      const bottom = Math.min(top + grid.clientHeight, grid.scrollHeight)
      let from = Number.POSITIVE_INFINITY
      let to = 0
      for (const row of grid.firstElementChild?.children ?? []) {
        const y = Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? Number.NaN)
        if (Number.isNaN(y)) continue
        from = Math.min(from, y)
        to = Math.max(to, y + Number.parseFloat(row.style.height || '0'))
      }
      if (from > top + 1 || to < bottom - 1) P.blank.push(time)
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  const observe = (type, push, extra = {}) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) push(entry)
      }).observe({ type, buffered: true, ...extra })
    } catch {}
  }
  observe('longtask', (e) => P.longtasks.push([e.startTime, e.duration]))
  observe('long-animation-frame', (e) =>
    P.loafs.push([e.startTime, e.duration, e.blockingDuration]),
  )
  observe('event', (e) => P.events.push([e.name, e.startTime, e.duration]), {
    durationThreshold: 16,
  })
  for (const type of ['keydown', 'input', 'dblclick']) {
    addEventListener(
      type,
      (event) => {
        const record = { type, code: event.code, t: event.timeStamp, frame: null }
        P.inputs.push(record)
        afterFrame((time) => {
          record.frame = time
        })
      },
      { capture: true },
    )
  }
  /** The frame after which `test` holds, or null after `timeout`. */
  P.waitFor = (test, timeout = 15000) =>
    new Promise((resolve) => {
      const start = performance.now()
      const tick = () => {
        let ok = false
        try {
          ok = test()
        } catch {}
        if (ok) return afterFrame(resolve)
        if (performance.now() - start > timeout) return resolve(null)
        requestAnimationFrame(tick)
      }
      tick()
    })
  /** Frames after changes inside `element` from now on (`P.quiet` reads them). */
  P.watch = (element) => {
    P.watching?.observer.disconnect()
    const times = []
    const observer = new MutationObserver(() => afterFrame((time) => times.push(time)))
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    P.watching = { times, observer }
  }
  /** The frame after the last watched change, once nothing changed for `quiet` ms. */
  P.quiet = (quiet = 300, timeout = 10000) =>
    new Promise((resolve) => {
      const start = performance.now()
      const check = () => {
        const last = P.watching?.times.at(-1)
        const now = performance.now()
        if (last === undefined || now - last > quiet || now - start > timeout) {
          P.watching?.observer.disconnect()
          resolve(last ?? null)
        } else setTimeout(check, 50)
      }
      setTimeout(check, quiet)
    })
}

// ——— Numbers ———
const pct = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const summary = (values) => ({
  n: values.length,
  p50: pct(values, 50),
  p95: pct(values, 95),
  max: values.length ? Math.max(...values) : null,
})

/** Frames between `from` and `to`: expected at 60 Hz, dropped, gaps over 33 ms, worst gap. */
function frameStats(frames, from, to) {
  const inside = frames.filter((time) => time >= from && time <= to)
  let dropped = 0
  let over33 = 0
  let worst = 0
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i] - inside[i - 1]
    worst = Math.max(worst, gap)
    dropped += Math.max(0, Math.round(gap / FRAME) - 1)
    if (gap > 2 * FRAME) over33++
  }
  const expected = inside.length > 1 ? Math.round((inside.at(-1) - inside[0]) / FRAME) : 0
  return { expected, dropped, over33, worst }
}

function addFrames(total, stats) {
  total.expected += stats.expected
  total.dropped += stats.dropped
  total.over33 += stats.over33
  total.worst = Math.max(total.worst, stats.worst)
}

async function pagePerf(page, from, to) {
  return page.evaluate(
    ([from, to]) => {
      const P = window.__perf
      const inWindow = ([start]) => start >= from && start <= to
      return {
        frames: P.frames.filter((time) => time >= from - 50 && time <= to + 50),
        longtasks: P.longtasks.filter(inWindow),
        loafs: P.loafs.filter(inWindow),
        events: P.events.filter(([, start]) => start >= from && start <= to),
        blank: P.blank.filter((time) => time >= from && time <= to).length,
      }
    },
    [from, to],
  )
}

const now = (page) => page.evaluate(() => performance.now())
const quiet = (page, ms = 600) => page.waitForTimeout(ms)

// ——— Scenarios ———
function newResult() {
  return {
    latency: [],
    settled: [],
    frames: { expected: 0, dropped: 0, over33: 0, worst: 0 },
    longtasks: [],
    loaf: [],
    eventTiming: [],
    blank: 0,
  }
}

function collect(result, perf, from, to) {
  addFrames(result.frames, frameStats(perf.frames, from, to))
  result.longtasks.push(...perf.longtasks.map(([, duration]) => duration))
  result.loaf.push(...perf.loafs.map(([, duration]) => duration))
  result.eventTiming.push(...perf.events.map(([, , duration]) => duration))
  result.blank += perf.blank
}

async function inputsSince(page, since, type) {
  await page.waitForFunction(
    ([since, type]) =>
      window.__perf.inputs.filter((i) => i.t >= since && i.type === type).every((i) => i.frame),
    [since, type],
  )
  return page.evaluate(
    ([since, type]) => window.__perf.inputs.filter((i) => i.t >= since && i.type === type),
    [since, type],
  )
}

async function search(page) {
  const result = newResult()
  await page.goto(`${BASE}/lora/library`)
  await page.waitForSelector('[role="listbox"], h1')
  await quiet(page, 1500)
  const box = page.locator('input[aria-label="Поиск"]')
  for (let run = 0; run <= RUNS; run++) {
    await box.fill('')
    await box.blur()
    await quiet(page, 400)
    await page.evaluate(() =>
      window.__perf.watch(document.querySelector('input[aria-label="Поиск"]').closest('.relative')),
    )
    const start = await now(page)
    await page.keyboard.press('Slash')
    for (const char of 'кружево') {
      await page.keyboard.type(char)
      await page.waitForTimeout(120)
    }
    await page.evaluate(() => window.__perf.quiet())
    const changes = await page.evaluate(() => window.__perf.watching.times)
    const end = await now(page)
    if (run === 0) continue // warm-up
    const inputs = await inputsSince(page, start, 'input')
    result.latency.push(...inputs.map((i) => i.frame - i.t))
    // The answer to the whole word: the first change of the suggestions after the last key
    // (from the index); the server's chronology may add a group later (`complete`).
    const last = inputs.at(-1)
    const after = changes.filter((time) => time > last.t)
    result.settled.push((after[0] ?? last.frame) - last.t)
    result.complete = [...(result.complete ?? []), (after.at(-1) ?? last.frame) - last.t]
    collect(result, await pagePerf(page, start, end), start, end)
  }
  await box.fill('')
  return result
}

const FYP_GRID = '[role="listbox"][aria-label="FYP"]'

async function scroll(page, cdp) {
  const result = newResult()
  await page.goto(`${BASE}/lora/library/fyp`)
  await page.waitForSelector(`${FYP_GRID} [role="option"]`)
  await quiet(page, 1500)
  const grid = await page.locator(FYP_GRID).boundingBox()
  for (let run = 0; run <= RUNS; run++) {
    await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      element.scrollTop = 0
      window.__perf.grid = element
    }, FYP_GRID)
    await quiet(page, 800)
    const distance = await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      return element.scrollHeight - element.clientHeight
    }, FYP_GRID)
    const start = await now(page)
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(grid.x + grid.width / 2),
      y: Math.round(grid.y + grid.height / 2),
      yDistance: -distance,
      speed: 8000,
      gestureSourceType: 'mouse',
      preventFling: true,
    })
    const end = await now(page)
    const reached = await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      return element.scrollTop / (element.scrollHeight - element.clientHeight)
    }, FYP_GRID)
    await page.evaluate(() => {
      window.__perf.grid = null
    })
    if (run === 0) continue
    result.settled.push(end - start) // gesture time
    result.reached = Math.min(result.reached ?? 1, reached)
    collect(result, await pagePerf(page, start, end), start, end)
  }
  return result
}

async function open(page) {
  const result = newResult()
  await page.goto(`${BASE}/lora/library/ppv`)
  const grid = '[role="listbox"][aria-label="PPV"]'
  await page.waitForSelector(`${grid} [role="option"]`)
  await quiet(page, 1500)
  // Every run opens a card it has not opened yet (no cached answer): PPV-073 first, then
  // its neighbours; the warm-up opens PPV-001.
  const numbers = [1, ...Array.from({ length: RUNS }, (_, i) => (i < 18 ? 73 + i : 72 - (i - 18)))]
  for (let run = 0; run <= RUNS; run++) {
    const id = `PPV-${String(numbers[run]).padStart(3, '0')}`
    const tile = page.locator(`${grid} [role="option"]`, { hasText: id })
    for (let step = 0; step < 40 && (await tile.count()) === 0; step++) {
      // Out of the virtual window: look further down the grid, from the top.
      await page.locator(grid).evaluate((element, first) => {
        element.scrollTop = first ? 0 : element.scrollTop + element.clientHeight * 0.8
      }, step === 0)
      await page.waitForTimeout(100)
    }
    await tile.scrollIntoViewIfNeeded()
    await quiet(page, 500)
    const start = await now(page)
    await tile.dblclick()
    const shown = await page.evaluate(
      (id) =>
        window.__perf.waitFor(
          () =>
            location.pathname.endsWith(`/i/${id}`) &&
            document.querySelector('h1')?.textContent?.length > 0 &&
            document.body.textContent.includes(id) &&
            !document.querySelector('[data-slot="skeleton"]'),
        ),
      id,
    )
    const end = await now(page)
    const [click] = (await inputsSince(page, start, 'dblclick')).slice(-1)
    await quiet(page, 400)
    await page.goBack()
    await page.waitForSelector(`${grid} [role="option"]`)
    if (run === 0) continue
    result.latency.push(click.frame - click.t)
    if (shown) result.settled.push(shown - click.t)
    collect(result, await pagePerf(page, start, end), start, end)
  }
  return result
}

async function select(page) {
  const result = newResult()
  await page.goto(`${BASE}/lora/library/fyp?where=lora-2:no`)
  await page.waitForSelector(`${FYP_GRID} [role="option"]`)
  await quiet(page, 1500)
  await page.locator(FYP_GRID).focus()
  for (let run = 0; run <= RUNS; run++) {
    await page.keyboard.press('Escape')
    await quiet(page, 500)
    const start = await now(page)
    await page.keyboard.press('ControlOrMeta+A')
    const shown = await page.evaluate(() =>
      window.__perf.waitFor(() =>
        document.querySelector('[aria-label^="Выбрано"]')?.getAttribute('aria-label'),
      ),
    )
    const end = await now(page)
    const keys = await inputsSince(page, start, 'keydown')
    const key = keys.find((k) => k.code === 'KeyA')
    result.count = await page.evaluate(
      () => document.querySelector('[aria-label^="Выбрано"]')?.getAttribute('aria-label') ?? null,
    )
    if (run === 0) continue
    result.latency.push(key.frame - key.t)
    if (shown) result.settled.push(shown - key.t)
    collect(result, await pagePerf(page, start, end), start, end)
  }
  await page.keyboard.press('Escape')
  return result
}

const SCENARIOS = { search, scroll, open, select }

// ——— Encoding load ———
function fixture() {
  const file = join(STORAGE, 'perf-4k.mp4')
  if (existsSync(file)) return file
  mkdirSync(STORAGE, { recursive: true })
  console.log('perf: drawing the 4K clip for the encoders…')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=3840x2160:rate=30',
    '-filter:v',
    'noise=alls=14:allf=t+u',
    '-t',
    '12',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '16',
    '-pix_fmt',
    'yuv420p',
    file,
  ])
  return file
}

/** Two encodes with the master profile, looping the clip until stopped. */
function startEncoders() {
  const input = fixture()
  return [1, 2].map(() =>
    spawn(
      'nice',
      [
        '-n',
        '10',
        'ffmpeg',
        '-hide_banner',
        '-loglevel',
        'error',
        '-stream_loop',
        '-1',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-c:v',
        'libsvtav1',
        '-preset',
        '6',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p10le',
        '-g',
        '300',
        '-svtav1-params',
        'tune=1:lp=4:enable-qm=1:qm-min=0:qm-max=15',
        '-f',
        'null',
        '-',
      ],
      { stdio: 'ignore' },
    ),
  )
}

function cpuOfEncoders(pids) {
  try {
    const out = execFileSync('ps', ['-o', '%cpu=', '-p', pids.join(',')], { encoding: 'utf8' })
    return out
      .trim()
      .split(/\s+/)
      .reduce((sum, value) => sum + Number(value), 0)
  } catch {
    return null
  }
}

// ——— Run ———
function machine() {
  let model = ''
  try {
    model = execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim()
  } catch {}
  return {
    model,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
  }
}

async function measureCondition(condition, scenarios) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !opts.headed })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 800 },
    deviceScaleFactor: Number(opts.dpr),
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  })
  await context.addInitScript(instrument)
  const signIn = await context.request.post(`${BASE}/api/v1/auth/sign-in`, {
    data: { login: opts.login, password: opts.password },
  })
  if (!signIn.ok()) throw new Error(`sign-in: ${signIn.status()}`)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  if (condition === 'throttle4') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  // Cold open of FYP: the index and the page summary fetched and the grid drawn.
  await page.goto(`${BASE}/lora/library/fyp`)
  const cold = await page.evaluate(() =>
    window.__perf.waitFor(() => document.querySelector('[role="listbox"] [role="option"] img')),
  )
  const index = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => /\/api\/v1\/lora\/(index|page-summaries)/.test(e.name))
      .map((e) => ({ url: new URL(e.name).pathname, bytes: e.encodedBodySize, ms: e.duration })),
  )

  const results = { cold, index, load: loadavg(), scenarios: {} }
  for (const name of scenarios) {
    process.stdout.write(`perf: ${condition} · ${name}…`)
    results.scenarios[name] = await SCENARIOS[name](page, cdp)
    process.stdout.write(' done\n')
  }
  await browser.close()
  return results
}

const round = (value) => (value === null || value === undefined ? '—' : Math.round(value))

function table(all) {
  const lines = [
    '| Сценарий | Условие | Отклик p50 / p95 / max, мс | До ответа p50 / p95 / max, мс | Пропущено кадров | Разрывы > 33 мс | Худший кадр, мс | Долгие задачи, шт. / max мс |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const [condition, result] of Object.entries(all.conditions)) {
    for (const [name, scenario] of Object.entries(result.scenarios)) {
      const latency = summary(scenario.latency)
      const settled = summary(scenario.settled)
      const f = scenario.frames
      const share = f.expected ? ((100 * f.dropped) / f.expected).toFixed(1) : '—'
      lines.push(
        `| ${name} | ${condition} | ${round(latency.p50)} / ${round(latency.p95)} / ${round(latency.max)} | ${round(settled.p50)} / ${round(settled.p95)} / ${round(settled.max)} | ${f.dropped} из ${f.expected} (${share} %) | ${f.over33} | ${round(f.worst)} | ${scenario.longtasks.length} / ${round(scenario.longtasks.length ? Math.max(...scenario.longtasks) : 0)} |`,
      )
    }
  }
  return lines.join('\n')
}

const all = {
  at: new Date().toISOString(),
  machine: machine(),
  browser: null,
  runs: RUNS,
  dpr: Number(opts.dpr),
  headed: opts.headed,
  conditions: {},
}
{
  const browser = await chromium.launch({ channel: 'chrome', headless: !opts.headed })
  all.browser = browser.version()
  await browser.close()
}
for (const condition of opts.conditions.split(',')) {
  let encoders = []
  if (condition === 'encoding') {
    encoders = startEncoders()
    await delay(15_000)
  }
  try {
    const result = await measureCondition(condition, opts.scenarios.split(','))
    if (encoders.length) result.encoderCpu = cpuOfEncoders(encoders.map((child) => child.pid))
    all.conditions[condition] = result
  } finally {
    for (const child of encoders) child.kill('SIGKILL')
  }
}
const out = opts.out ?? join(STORAGE, `perf-${all.at.replace(/[:.]/g, '-')}.json`)
writeFileSync(out, JSON.stringify(all, null, 2))
console.log(`\n${JSON.stringify(all.machine)} · Chrome ${all.browser}`)
for (const [condition, result] of Object.entries(all.conditions)) {
  console.log(
    `${condition}: load ${result.load.map((v) => v.toFixed(1)).join(' ')}` +
      (result.encoderCpu ? ` · encoders ${Math.round(result.encoderCpu)} % CPU` : '') +
      ` · cold FYP ${round(result.cold)} ms · ${result.index.map((i) => `${i.url} ${Math.round(i.bytes / 1024)} KB`).join(', ')}`,
  )
}
console.log(`\n${table(all)}\n\nraw: ${out}`)
