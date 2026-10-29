import { useEffect, useState } from 'react'

/** Значение, которое догоняет исходное после паузы ввода: разбор не идёт на каждую букву. */
export function useDebouncedValue<Value>(value: Value, delayMs: number): Value {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return settled
}
