import { useLocation } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { readHistoryValue, writeHistoryValue } from './history-state'

const LocationKeySchema = z.object({ __TSR_key: z.string().optional() })

/** Ключ текущей записи истории: при замене записи значение переписывается и в новую. */
function useHistoryEntryKey(): string | undefined {
  return useLocation({
    select: (location) => LocationKeySchema.safeParse(location.state).data?.__TSR_key,
  })
}

/**
 * Состояние экрана, которое живёт в записи истории (выделение, раскрытые группы).
 * Начальное значение берётся из `history.state`, каждое изменение туда же и пишется.
 */
export function useHistoryState<Schema extends z.ZodType>(
  key: string,
  schema: Schema,
  fallback: () => z.output<Schema>,
) {
  const [value, setValue] = useState<z.output<Schema>>(
    () => readHistoryValue(key, schema) ?? fallback(),
  )
  // Запись переписывается и при смене записи истории (замена адреса фильтром), иначе
  // новая запись осталась бы без выделения.
  const entryKey = useHistoryEntryKey()
  useEffect(() => {
    writeHistoryValue(key, value)
  }, [key, value, entryKey])
  return [value, setValue] as const
}

const SCROLL_WRITE_DELAY_MS = 120
const ScrollOffsetSchema = z.number().nonnegative()

/**
 * Место прокрутки в записи истории: запись с задержкой, чтобы не трогать историю на
 * каждом кадре прокрутки. Возвращает начальное смещение и обработчик прокрутки.
 */
export function useHistoryScroll(key: string) {
  const [initialOffset] = useState(() => readHistoryValue(key, ScrollOffsetSchema))
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onScrollOffsetChange = useCallback(
    (offset: number) => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(
        () => writeHistoryValue(key, Math.round(offset)),
        SCROLL_WRITE_DELAY_MS,
      )
    },
    [key],
  )
  return { initialOffset, onScrollOffsetChange }
}
