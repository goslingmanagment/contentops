import { type CheckSuggestion, formatNumber } from '@contentops/contracts'
import { stopRowClick } from '@contentops/ui/components/stop-row-click'
import { Link } from '@tanstack/react-router'
import { useCurrentModel } from '@/shell/model/model-context'

/** «15 из 15»: сколько файлов поста нашлось среди файлов объекта. */
export function matchedLabel(suggestion: CheckSuggestion): string {
  return `${formatNumber(suggestion.matched)} из ${formatNumber(suggestion.total)}`
}

/**
 * «по именам файлов: SET-046 · 15 из 15» (SPEC §7): пост выложен с исходниками диска, их имена
 * — у файлов этого объекта. Подсказка, не решение: привязывает человек. ID ведёт в карточку.
 */
export function SuggestionHint({ suggestion }: { suggestion: CheckSuggestion }) {
  const model = useCurrentModel()
  return (
    <>
      по именам файлов:{' '}
      <Link
        to="/$model/i/$id"
        params={{ model: model.code, id: suggestion.item_id }}
        onClick={stopRowClick}
        className="text-primary-ink underline-offset-4 hover:underline"
      >
        {suggestion.item_id}
      </Link>
      {` · ${matchedLabel(suggestion)}`}
    </>
  )
}
