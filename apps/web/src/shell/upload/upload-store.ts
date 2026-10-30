import type { ItemId, MediaKind, ModelCode, UploadedFile, UploadKind } from '@contentops/contracts'
import type { ServerFile } from '@/lib/save-file'
import type { UploadTarget } from './upload-target'

/**
 * Ход загрузок и долгих сборок для лотка (DESIGN §3.7). Файлы идут по очереди, как у
 * Я.Диска: «Загружается 3 из 5». Байты идут кусками по tus (SPEC §6.1), после обрыва —
 * «Загрузка прервана · Продолжить» с принятого байта. Одно нажатие «Загрузить» — одна
 * пачка: когда все её файлы переданы, пачка уходит на сервер одной командой, и готовой она
 * считается только после его ответа: «в Приехало» или «принято → PPV-089».
 */

export type UploadPhase = 'queued' | 'uploading' | 'interrupted' | 'checking' | 'done' | 'failed'

/**
 * `tus` — байты идут на сервер; `simulated` — экран ещё на заглушке (строка плана в
 * разработке): ход передачи изображается, команда уходит в заглушку.
 */
export type UploadTransport = 'tus' | 'simulated'

export interface UploadEntry {
  id: string
  batchId: string
  fileName: string
  sizeBytes: number
  media: MediaKind
  loadedBytes: number
  phase: UploadPhase
  transport: UploadTransport
  /** Загрузка tus, которая несёт байты: её называет команда. */
  uploadId: string | null
  /** Проверка длится не меньше этого времени, мс от начала страницы. */
  checkEndsAt: number | null
}

/** Что сказал сервер о пачке. */
export type UploadOutcome =
  | { kind: 'inbox'; decision: boolean }
  | { kind: 'attached'; itemId: ItemId }
  | { kind: 'failed'; message: string }

export interface UploadBatch {
  /** Он же ключ повтора команды. */
  id: string
  model: ModelCode
  kind: UploadKind
  target: UploadTarget | null
  /** Что уйдёт в команде: загрузка, имя, размер, фото или видео. */
  files: readonly Omit<UploadedFile, 'upload_id'>[]
  transport: UploadTransport
  /** `sent` — команда ушла; `settled` — ответ пришёл, итог в `outcome`. */
  status: 'transferring' | 'sent' | 'settled'
  outcome: UploadOutcome | null
}

export interface OperationEntry {
  id: string
  model: ModelCode
  label: string
  progress: number
  state: 'running' | 'done' | 'failed'
  /** Готовый файл, который отдаёт «Скачать» в лотке («Архив дня готов · Fansly 1»). */
  download?: ServerFile
}

/** Ход сборки по ответу сервера. */
export interface OperationUpdate {
  id: string
  label: string
  progress: number
  state: OperationEntry['state']
  download?: ServerFile
}

export interface UploadState {
  uploads: UploadEntry[]
  batches: UploadBatch[]
  operations: OperationEntry[]
  collapsed: boolean
}

export const initialUploadState: UploadState = {
  uploads: [],
  batches: [],
  operations: [],
  collapsed: false,
}

export interface NewUploadFile {
  id: string
  fileName: string
  sizeBytes: number
  media: MediaKind
}

export type UploadAction =
  | {
      type: 'add-batch'
      batch: Omit<UploadBatch, 'status' | 'outcome' | 'files' | 'transport'>
      files: readonly NewUploadFile[]
      transport: UploadTransport
    }
  | { type: 'tick'; elapsedMs: number; now: number }
  | { type: 'progress'; id: string; loadedBytes: number }
  | { type: 'transferred'; id: string; uploadId: string; now: number }
  | { type: 'interrupted'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'batch-sent'; id: string }
  | { type: 'batch-settled'; id: string; outcome: UploadOutcome }
  | { type: 'cancel-uploads' }
  | { type: 'clear-finished' }
  | { type: 'track-operation'; operation: OperationEntry }
  | ({ type: 'update-operation' } & OperationUpdate)
  | { type: 'set-collapsed'; collapsed: boolean }

/** Скорость изображаемой передачи: в заглушку файлы не шлются. */
const SIMULATED_BYTES_PER_MS = 60_000
export const CHECK_DURATION_MS = 1_200

function transfer(uploads: readonly UploadEntry[], elapsedMs: number, now: number): UploadEntry[] {
  let budget = elapsedMs * SIMULATED_BYTES_PER_MS
  let started = false
  return uploads.map((entry) => {
    if (
      entry.transport !== 'simulated' ||
      (entry.phase !== 'queued' && entry.phase !== 'uploading')
    ) {
      return entry
    }
    if (started || budget <= 0) {
      started = true
      return entry
    }
    const loaded = Math.min(entry.sizeBytes, entry.loadedBytes + budget)
    budget -= loaded - entry.loadedBytes
    if (loaded >= entry.sizeBytes) {
      return {
        ...entry,
        loadedBytes: loaded,
        phase: 'checking',
        uploadId: crypto.randomUUID(),
        checkEndsAt: now + CHECK_DURATION_MS,
      }
    }
    started = true
    return { ...entry, loadedBytes: loaded, phase: 'uploading' }
  })
}

/** Проверка кончается, когда прошло её время и сервер ответил по пачке. */
function finishChecks(state: UploadState, now: number): UploadEntry[] {
  return state.uploads.map((entry) => {
    if (entry.phase !== 'checking' || entry.checkEndsAt === null || entry.checkEndsAt > now) {
      return entry
    }
    const outcome = state.batches.find((batch) => batch.id === entry.batchId)?.outcome
    if (!outcome) {
      return entry
    }
    return { ...entry, phase: outcome.kind === 'failed' ? 'failed' : 'done', checkEndsAt: null }
  })
}

function isFinished(entry: UploadEntry): boolean {
  return entry.phase === 'done' || entry.phase === 'failed'
}

/** Пачки без файлов в лотке больше не нужны. */
function withLiveBatches(state: UploadState, uploads: UploadEntry[]): UploadState {
  const live = new Set(uploads.map((entry) => entry.batchId))
  return { ...state, uploads, batches: state.batches.filter((batch) => live.has(batch.id)) }
}

export function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case 'add-batch':
      return {
        ...state,
        collapsed: false,
        batches: [
          ...state.batches,
          {
            ...action.batch,
            transport: action.transport,
            files: action.files.map((file) => ({
              file_name: file.fileName,
              size_bytes: file.sizeBytes,
              media: file.media,
            })),
            status: 'transferring',
            outcome: null,
          },
        ],
        uploads: [
          ...state.uploads,
          ...action.files.map((file) => ({
            ...file,
            batchId: action.batch.id,
            loadedBytes: 0,
            phase: 'queued' as const,
            transport: action.transport,
            uploadId: null,
            checkEndsAt: null,
          })),
        ],
      }
    case 'tick': {
      const moved = { ...state, uploads: transfer(state.uploads, action.elapsedMs, action.now) }
      return { ...moved, uploads: finishChecks(moved, action.now) }
    }
    case 'progress':
      return withEntry(state, action.id, (entry) => ({
        ...entry,
        phase: 'uploading',
        loadedBytes: Math.min(entry.sizeBytes, action.loadedBytes),
      }))
    case 'transferred':
      return withEntry(state, action.id, (entry) => ({
        ...entry,
        phase: 'checking',
        loadedBytes: entry.sizeBytes,
        uploadId: action.uploadId,
        checkEndsAt: action.now,
      }))
    case 'interrupted':
      return withEntry(state, action.id, (entry) =>
        entry.phase === 'uploading' || entry.phase === 'queued'
          ? { ...entry, phase: 'interrupted' }
          : entry,
      )
    case 'resume':
      return withEntry(state, action.id, (entry) =>
        entry.phase === 'interrupted' ? { ...entry, phase: 'queued' } : entry,
      )
    case 'batch-sent':
      return {
        ...state,
        batches: state.batches.map((batch) =>
          batch.id === action.id ? { ...batch, status: 'sent' } : batch,
        ),
      }
    case 'batch-settled':
      return {
        ...state,
        batches: state.batches.map((batch) =>
          batch.id === action.id ? { ...batch, status: 'settled', outcome: action.outcome } : batch,
        ),
      }
    case 'cancel-uploads':
      return withLiveBatches(state, state.uploads.filter(isFinished))
    case 'clear-finished':
      return {
        ...withLiveBatches(
          state,
          state.uploads.filter((entry) => !isFinished(entry)),
        ),
        operations: state.operations.filter((entry) => entry.state === 'running'),
      }
    case 'track-operation':
      return {
        ...state,
        collapsed: false,
        operations: [
          ...state.operations.filter((entry) => entry.id !== action.operation.id),
          action.operation,
        ],
      }
    case 'update-operation':
      return {
        ...state,
        operations: state.operations.map((entry) =>
          entry.id === action.id
            ? {
                ...entry,
                label: action.label,
                progress: action.progress,
                state: action.state,
                download: action.download ?? entry.download,
              }
            : entry,
        ),
      }
    case 'set-collapsed':
      return { ...state, collapsed: action.collapsed }
  }
}

function withEntry(
  state: UploadState,
  id: string,
  change: (entry: UploadEntry) => UploadEntry,
): UploadState {
  return {
    ...state,
    uploads: state.uploads.map((entry) => (entry.id === id ? change(entry) : entry)),
  }
}

/** Следующий файл для передачи по tus: по одному, как у Я.Диска. */
export function nextToTransfer(state: UploadState): UploadEntry | null {
  const tus = state.uploads.filter((entry) => entry.transport === 'tus')
  if (tus.some((entry) => entry.phase === 'uploading')) {
    return null
  }
  return tus.find((entry) => entry.phase === 'queued') ?? null
}

/** Файлы команды пачки: каждый со своей загрузкой tus. */
export function commandFiles(state: UploadState, batch: UploadBatch): UploadedFile[] {
  const entries = state.uploads.filter((entry) => entry.batchId === batch.id)
  return batch.files.map((file, index) => ({
    upload_id: entries[index]?.uploadId ?? '',
    ...file,
  }))
}

/** Пачки, все файлы которых переданы, а команда ещё не ушла. */
export function batchesReadyToSend(state: UploadState): UploadBatch[] {
  return state.batches.filter((batch) => {
    if (batch.status !== 'transferring') {
      return false
    }
    const files = state.uploads.filter((entry) => entry.batchId === batch.id)
    return files.length > 0 && files.every((entry) => entry.phase === 'checking')
  })
}

export function batchOf(state: UploadState, entry: UploadEntry): UploadBatch | undefined {
  return state.batches.find((batch) => batch.id === entry.batchId)
}

export function isUploadActive(entry: UploadEntry): boolean {
  return !isFinished(entry)
}

export function hasActiveWork(state: UploadState): boolean {
  return (
    state.uploads.some(isUploadActive) ||
    state.operations.some((operation) => operation.state === 'running')
  )
}
