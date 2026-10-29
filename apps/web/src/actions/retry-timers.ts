/**
 * Автоповторы после 429 (DESIGN §3.8): у каждого намерения свой таймер. Новый отказ
 * того же намерения переносит его повтор, отказ другого — не трогает: раньше один общий
 * таймер на приложение отменял прошлый повтор, и действие пропадало молча.
 */
export class RetryTimers {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #anonymous = 0

  /** `key` — ключ повтора намерения; без него повтор ни с чем не сливается. */
  schedule(key: string | undefined, delayMs: number, run: () => void): void {
    this.#anonymous += 1
    const id = key ?? `anonymous-${this.#anonymous}`
    clearTimeout(this.#timers.get(id))
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id)
        run()
      }, delayMs),
    )
  }

  clearAll(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer)
    }
    this.#timers.clear()
  }
}
