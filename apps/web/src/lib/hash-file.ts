import { sha256OfFile } from './sha256'
import type { HashMessage } from './sha256.worker'

/**
 * SHA-256 брошенного файла (DESIGN §4.7): в Web Worker, доля — в `onProgress`. Без воркера
 * (тесты, старый браузер) — тем же кодом здесь же.
 */
export function hashFile(
  file: File,
  onProgress: (share: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof Worker === 'undefined') return sha256OfFile(file, onProgress)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), { type: 'module' })
    const stop = () => {
      worker.terminate()
      reject(new DOMException('Отменено', 'AbortError'))
    }
    signal?.addEventListener('abort', stop, { once: true })
    worker.onmessage = (event: MessageEvent<HashMessage>) => {
      const message = event.data
      if (message.kind === 'progress') {
        onProgress(message.share)
        return
      }
      signal?.removeEventListener('abort', stop)
      worker.terminate()
      if (message.kind === 'done') resolve(message.sha256)
      else reject(new Error('Хэш не посчитался'))
    }
    worker.onerror = () => {
      signal?.removeEventListener('abort', stop)
      worker.terminate()
      reject(new Error('Хэш не посчитался'))
    }
    worker.postMessage({ file })
  })
}
