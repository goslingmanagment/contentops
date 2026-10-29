import { formatBytes, formatPercent } from '@contentops/contracts'
import { describe, expect, it, vi } from 'vitest'
import { trayItems, trayTitle } from './tray-labels'
import {
  batchesReadyToSend,
  CHECK_DURATION_MS,
  hasActiveWork,
  initialUploadState,
  type UploadAction,
  type UploadState,
  uploadReducer,
} from './upload-store'

const MB = 1_000_000
const save = () => {}

function run(state: UploadState, ...actions: UploadAction[]): UploadState {
  return actions.reduce(uploadReducer, state)
}

function withBatch(target: 'item' | null = null): UploadState {
  return run(initialUploadState, {
    type: 'add-batch',
    batch: {
      id: 'batch-1',
      model: 'lora',
      kind: target ? 'teaser' : 'other',
      target: target ? { kind: 'item', itemId: 'PPV-089', title: 'Вдвоём на диване' } : null,
    },
    files: [
      { id: 'u1', fileName: 'a.jpg', sizeBytes: 3 * MB, media: 'photo' },
      { id: 'u2', fileName: 'b.jpg', sizeBytes: 3 * MB, media: 'photo' },
    ],
  })
}

describe('лоток загрузок', () => {
  it('файлы идут по очереди: пока первый не передан, второй ждёт', () => {
    const state = run(withBatch(), { type: 'tick', elapsedMs: 25, now: 25 })
    expect(state.uploads.map((entry) => entry.phase)).toEqual(['uploading', 'queued'])
    expect(trayTitle(state)).toMatch(/^Загружается 1 из 2 · /)
  })

  it('пачка уходит на сервер, когда переданы все её файлы, и только один раз', () => {
    const transferred = run(withBatch(), { type: 'tick', elapsedMs: 1_000, now: 1_000 })
    expect(transferred.uploads.every((entry) => entry.phase === 'checking')).toBe(true)
    expect(batchesReadyToSend(transferred).map((batch) => batch.id)).toEqual(['batch-1'])
    expect(batchesReadyToSend(transferred)[0]?.files).toEqual([
      { file_name: 'a.jpg', size_bytes: 3 * MB, media: 'photo' },
      { file_name: 'b.jpg', size_bytes: 3 * MB, media: 'photo' },
    ])
    const sent = run(transferred, { type: 'batch-sent', id: 'batch-1' })
    expect(batchesReadyToSend(sent)).toEqual([])
    // Байты на месте, идёт проверка — заголовок не пишет «Загружается … 6 из 6 МБ».
    expect(trayTitle(sent)).toBe('Проверяется 2 файла')
  })

  it('без ответа сервера проверка не кончается, даже когда время прошло', () => {
    const state = run(
      withBatch(),
      { type: 'tick', elapsedMs: 1_000, now: 1_000 },
      { type: 'batch-sent', id: 'batch-1' },
      { type: 'tick', elapsedMs: 10, now: 1_000 + CHECK_DURATION_MS + 10 },
    )
    expect(state.uploads.every((entry) => entry.phase === 'checking')).toBe(true)
    expect(hasActiveWork(state)).toBe(true)
  })

  it('«Другое» после ответа — «в Приехало · Что это?»', () => {
    const state = run(
      withBatch(),
      { type: 'tick', elapsedMs: 1_000, now: 1_000 },
      { type: 'batch-sent', id: 'batch-1' },
      { type: 'batch-settled', id: 'batch-1', outcome: { kind: 'inbox', decision: true } },
      { type: 'tick', elapsedMs: 10, now: 1_000 + CHECK_DURATION_MS + 10 },
    )
    expect(trayItems(state, save).map((item) => [item.state, item.detail])).toEqual([
      ['done', 'в Приехало · Что это?'],
      ['done', 'в Приехало · Что это?'],
    ])
    expect(hasActiveWork(state)).toBe(false)
    expect(trayTitle(state)).toBe('Загружено 2 файла')
  })

  it('с целью — «принято → PPV-089»; отказ сервера — ▲ с причиной', () => {
    const accepted = run(
      withBatch('item'),
      { type: 'tick', elapsedMs: 1_000, now: 1_000 },
      { type: 'batch-settled', id: 'batch-1', outcome: { kind: 'attached', itemId: 'PPV-089' } },
      { type: 'tick', elapsedMs: 10, now: 1_000 + CHECK_DURATION_MS + 10 },
    )
    expect(trayItems(accepted, save)[0]).toMatchObject({
      state: 'done',
      detail: 'принято → PPV-089',
    })

    const refused = run(
      withBatch('item'),
      { type: 'tick', elapsedMs: 1_000, now: 1_000 },
      {
        type: 'batch-settled',
        id: 'batch-1',
        outcome: { kind: 'failed', message: 'тизер — один видеофайл' },
      },
      { type: 'tick', elapsedMs: 10, now: 1_000 + CHECK_DURATION_MS + 10 },
    )
    expect(trayItems(refused, save)[0]).toMatchObject({
      state: 'failed',
      detail: 'не принято: тизер — один видеофайл',
    })
  })

  it('«Отменить загрузки» и «Убрать лоток» уносят и пачки без файлов', () => {
    const cancelled = run(withBatch(), { type: 'cancel-uploads' })
    expect(cancelled.uploads).toEqual([])
    expect(cancelled.batches).toEqual([])

    const finished = run(
      withBatch(),
      { type: 'tick', elapsedMs: 1_000, now: 1_000 },
      { type: 'batch-settled', id: 'batch-1', outcome: { kind: 'inbox', decision: false } },
      { type: 'tick', elapsedMs: 10, now: 1_000 + CHECK_DURATION_MS + 10 },
      { type: 'clear-finished' },
    )
    expect(finished).toMatchObject({ uploads: [], batches: [] })
  })

  it('готовая сборка — «Архив дня готов · Fansly 1», размер и «Скачать»', () => {
    const saveFile = vi.fn()
    const state = run(
      initialUploadState,
      {
        type: 'track-operation',
        operation: {
          id: 'op-1',
          model: 'lora',
          label: 'Архив дня собирается',
          progress: 0,
          state: 'running',
        },
      },
      {
        type: 'update-operation',
        id: 'op-1',
        label: 'Архив дня собирается · Fansly 1',
        progress: 0.4,
        state: 'running',
      },
    )
    expect(trayTitle(state)).toBe(`Архив дня собирается · Fansly 1 · ${formatPercent(0.4)}`)
    expect(trayItems(state, saveFile)[0]).toMatchObject({
      detail: formatPercent(0.4),
      action: undefined,
    })

    const file = { url: '/api/v1/lora/downloads/day.zip', fileName: 'day.zip', sizeBytes: 60 * MB }
    const done = run(state, {
      type: 'update-operation',
      id: 'op-1',
      label: 'Архив дня готов · Fansly 1',
      progress: 1,
      state: 'done',
      download: file,
    })
    const [item] = trayItems(done, saveFile)
    expect(item).toMatchObject({
      name: 'Архив дня готов · Fansly 1',
      state: 'done',
      detail: formatBytes(60 * MB),
    })
    expect(item?.name).not.toMatch(/собирается/)
    item?.action?.onSelect()
    expect(saveFile).toHaveBeenCalledWith(file)
  })
})
