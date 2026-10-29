import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { SearchIcon, SearchXIcon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { FieldMessage } from '@/shell/field/field-message'
import { useOptionalModel } from '@/shell/model/model-context'
import { useOpenSearch } from '@/shell/search/use-open-search'

interface NotFoundStateProps {
  /** «PPV-099 у Лоры нет»; по умолчанию — «Такой страницы нет». */
  message?: string
}

/** 404 на месте поля (DESIGN §3.10): фраза и строка поиска. */
export function NotFoundState({ message = 'Такой страницы нет' }: NotFoundStateProps) {
  const model = useOptionalModel()
  return (
    <FieldMessage>
      <SearchXIcon aria-hidden className="size-6 text-ink-3" />
      <p className="text-lg">{message}</p>
      {model ? <FieldSearch model={model.code} /> : null}
    </FieldMessage>
  )
}

function FieldSearch({ model }: { model: string }) {
  const [query, setQuery] = useState('')
  const openSearch = useOpenSearch()
  const inputId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (query.trim()) {
      openSearch(model, query)
    }
  }
  return (
    <form onSubmit={submit} className="flex w-full max-w-100 items-center gap-2">
      <label htmlFor={inputId} className="sr-only">
        Найти
      </label>
      <Input
        id={inputId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Найти: ппв 73, кастом в колготках…"
      />
      <Button type="submit" variant="secondary" size="icon" aria-label="Найти">
        <SearchIcon />
      </Button>
    </form>
  )
}
