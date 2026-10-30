import { Input } from '@contentops/ui/components/input'
import { SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useDebouncedValue } from './new-order/use-debounced-value'

const SEARCH_DELAY_MS = 250

interface OrderSearchFieldProps {
  value: string
  onChange: (value: string) => void
}

/**
 * «Найти заказ» (`/`, DESIGN §4.16): покупатель, название, ТЗ — сразу во всех вкладках.
 * В адрес слово уходит после паузы ввода, а не на каждую букву.
 */
export function OrderSearchField({ value, onChange }: OrderSearchFieldProps) {
  const [draft, setDraft] = useState(value)
  const settled = useDebouncedValue(draft, SEARCH_DELAY_MS)
  const input = useRef<HTMLInputElement>(null)
  const commit = useRef(onChange)
  commit.current = onChange
  useEffect(() => {
    if (settled.trim() !== value.trim()) commit.current(settled.trim())
  }, [settled, value])
  useKeyboardShortcut({ code: 'Slash' }, () => input.current?.focus())
  return (
    <div className="relative">
      <SearchIcon
        aria-hidden
        className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground"
      />
      <Input
        ref={input}
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft('')
        }}
        placeholder="Найти заказ"
        aria-label="Найти заказ"
        className="h-8 w-56 pl-8"
      />
    </div>
  )
}
