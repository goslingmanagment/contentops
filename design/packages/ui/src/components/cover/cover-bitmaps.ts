/**
 * Обложки-заглушки в картинках (DESIGN §7.9, §3.13): сцена рисуется один раз на ключ
 * (зерно, семейство, пропорция, кадр, размер) в растр и дальше живёт `<img>`, как
 * настоящая миниатюра из сети. Живые SVG по ~80 узлов давали 80 % узлов DOM и почти всю
 * цену кадра прокрутки, и замер для порогов PLAN мерил рисунок, а не продукт.
 *
 * Растр готовится очередью в свободное время главного потока (`requestIdleCallback`):
 * сначала то, что попросили последним (видимое при прокрутке), и только пока плитка на
 * экране. Прокрутка не ждёт рисования: пока картинки нет, место держит фон `--muted`, как
 * у миниатюры, которая ещё идёт из сети (§3.10).
 */

export interface CoverBitmapRequest {
  key: string
  width: number
  height: number
  /** Разметка SVG сцены с подставленными цветами. */
  markup: () => string
}

interface Entry {
  request: CoverBitmapRequest
  url: string | null
  state: 'idle' | 'queued' | 'drawing' | 'ready' | 'failed'
  listeners: Set<() => void>
}

const entries = new Map<string, Entry>()
/** Последний запрос — первым: при прокрутке это ряд, который сейчас на экране. */
const queue: string[] = []
const PARALLEL = 2
/** Сколько свободного времени кадра нужно, чтобы начать следующую обложку, мс. */
const IDLE_BUDGET_MS = 6
let drawing = 0
let scheduled = false

function schedule() {
  if (scheduled) {
    return
  }
  scheduled = true
  const run = (deadline?: IdleDeadline) => {
    scheduled = false
    pump(deadline)
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 1000 })
  } else {
    setTimeout(run, 16)
  }
}

function entryOf(request: CoverBitmapRequest): Entry {
  let entry = entries.get(request.key)
  if (!entry) {
    entry = { request, url: null, state: 'idle', listeners: new Set() }
    entries.set(request.key, entry)
  }
  return entry
}

export function coverBitmapUrl(key: string): string | null {
  return entries.get(key)?.url ?? null
}

/** Подписка плитки: пока она на экране, её обложка в очереди; ушла — вышла из очереди. */
export function watchCoverBitmap(request: CoverBitmapRequest, listener: () => void): () => void {
  const entry = entryOf(request)
  entry.listeners.add(listener)
  if (entry.state === 'idle') {
    entry.state = 'queued'
    queue.push(request.key)
    schedule()
  } else if (entry.state === 'queued') {
    const index = queue.indexOf(request.key)
    if (index >= 0) {
      queue.splice(index, 1)
    }
    queue.push(request.key)
  }
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0 && entry.state === 'queued') {
      entry.state = 'idle'
      const index = queue.indexOf(request.key)
      if (index >= 0) {
        queue.splice(index, 1)
      }
    }
  }
}

function pump(deadline?: IdleDeadline) {
  while (drawing < PARALLEL && queue.length > 0) {
    if (deadline && !deadline.didTimeout && deadline.timeRemaining() < IDLE_BUDGET_MS) {
      break
    }
    const key = queue.pop()
    const entry = key === undefined ? undefined : entries.get(key)
    if (entry?.state !== 'queued') {
      continue
    }
    entry.state = 'drawing'
    drawing += 1
    void draw(entry.request)
      .then(
        (url) => {
          entry.url = url
          entry.state = 'ready'
        },
        () => {
          entry.state = 'failed'
        },
      )
      .finally(() => {
        drawing -= 1
        for (const listener of entry.listeners) {
          listener()
        }
        schedule()
      })
  }
  if (queue.length > 0) {
    schedule()
  }
}

async function draw({ width, height, markup }: CoverBitmapRequest): Promise<string> {
  const svgUrl = URL.createObjectURL(new Blob([markup()], { type: 'image/svg+xml' }))
  try {
    const image = new Image(width, height)
    image.src = svgUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Нет 2d-контекста для обложки')
    }
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.9),
    )
    if (!blob) {
      throw new Error('Обложка не записалась')
    }
    return URL.createObjectURL(blob)
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}
