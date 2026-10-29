import { normalizeQuery, type Tag } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { XIcon } from 'lucide-react'
import { type KeyboardEvent, useId, useMemo, useState } from 'react'
import { useTags } from '@/data/catalog'
import { FieldRow } from './field-row'
import type { DraftSave } from './use-draft-save'

const SUGGESTIONS = 6

interface TagFieldProps {
  tags: readonly string[]
  saver: DraftSave
}

function nameOf(key: string, names: ReadonlyMap<string, string>): string {
  return names.get(key) ?? key
}

/** Подходящие теги словаря: по русскому имени и ключу, самые частые первыми. */
function suggest(vocabulary: readonly Tag[], taken: readonly string[], query: string): Tag[] {
  const text = normalizeQuery(query)
  if (!text) {
    return []
  }
  return vocabulary
    .filter((tag) => !taken.includes(tag.key))
    .filter((tag) => normalizeQuery(`${tag.ru ?? ''} ${tag.key}`).includes(text))
    .toSorted((left, right) => right.uses - left.uses)
    .slice(0, SUGGESTIONS)
}

/**
 * «Теги» строкой (DESIGN §4.8, §8 `TagInput`): метки с «×», ввод, `Enter` добавляет,
 * ниже — подходящие теги словаря. Каждое изменение сохраняется сразу, с «Отменить».
 */
export function TagField({ tags, saver }: TagFieldProps) {
  const id = useId()
  const vocabulary = useTags().data ?? []
  const names = useMemo(
    () => new Map(vocabulary.map((tag) => [tag.key, tag.ru ?? tag.key])),
    [vocabulary],
  )
  const [query, setQuery] = useState('')
  const suggestions = suggest(vocabulary, tags, query)

  const save = (next: readonly string[]) => void saver.save({ tags: [...next] })
  const add = (key: string) => {
    setQuery('')
    if (key && !tags.includes(key)) {
      save([...tags, key])
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      const known = suggestions[0]
      add(known ? known.key : query.trim())
    }
    const last = tags.at(-1)
    if (event.key === 'Backspace' && !query && last !== undefined) {
      save(tags.slice(0, -1))
    }
  }

  return (
    <FieldRow
      label="Теги"
      htmlFor={id}
      aside={saver.savingField === 'tags' ? 'сохраняется…' : null}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
        {tags.map((key) => (
          <Badge key={key} className="h-6 gap-1 pr-1 text-sm">
            {nameOf(key, names)}
            <button
              type="button"
              aria-label={`Убрать тег ${nameOf(key, names)}`}
              onClick={() => save(tags.filter((tag) => tag !== key))}
              className="rounded-sm text-ink-3 hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={tags.length === 0 ? 'кружево, у зеркала…' : ''}
          className="h-6 min-w-24 flex-1 bg-transparent text-base outline-none placeholder:text-ink-3"
        />
      </div>
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((tag) => (
            <button
              key={tag.key}
              type="button"
              onClick={() => add(tag.key)}
              className="h-7 rounded-3xl bg-secondary px-2.5 text-sm transition-colors duration-120 hover:bg-secondary-hover"
            >
              {tag.ru ?? tag.key}
            </button>
          ))}
        </div>
      ) : null}
    </FieldRow>
  )
}
