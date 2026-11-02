import { sha256OfFile } from './sha256'

/** Хэш файла в фоновом потоке (DESIGN §4.7): страница не замирает на гигабайтном мастере. */

interface WorkerScope {
  postMessage(message: HashMessage): void
  onmessage: ((event: MessageEvent<{ file: File }>) => void) | null
}

export type HashMessage =
  | { kind: 'progress'; share: number }
  | { kind: 'done'; sha256: string }
  | { kind: 'failed' }

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  sha256OfFile(event.data.file, (share) => scope.postMessage({ kind: 'progress', share })).then(
    (sha256) => scope.postMessage({ kind: 'done', sha256 }),
    () => scope.postMessage({ kind: 'failed' }),
  )
}
