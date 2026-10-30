import type { createMockSession } from './mock-session'

type CreateMockSession = typeof createMockSession

let createMock: CreateMockSession | null = null

/**
 * Подключает заглушку API в разработке (`pnpm dev`, тесты) до первого рисования. В сборке
 * продукта `import.meta.env.DEV` ложно: ветка вырезается вместе с модулем заглушки, и все
 * запросы идут на сервер.
 */
export async function loadDevMock(): Promise<void> {
  if (import.meta.env.DEV) {
    createMock = (await import('./mock-session')).createMockSession
  }
}

/** Заглушка, если она подключена; `null` — в сборке продукта. */
export function devMock(): CreateMockSession | null {
  return createMock
}
