import { type FileMatch, formatNumber, type ItemId, type ModelCode } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { XIcon } from 'lucide-react'
import type { FileSearchState } from './use-file-search'

/** «Считаем хэш «master.mp4» · 42 %» — что видно в самой строке поиска (DESIGN §4.7). */
export function fileSearchLine(state: FileSearchState): string {
  switch (state.kind) {
    case 'hashing':
      return `Считаем хэш «${state.name}» · ${formatNumber(Math.floor(state.share * 100))} %`
    case 'asking':
      return `Ищем такой же файл, как «${state.name}»…`
    case 'done':
    case 'failed':
      return `Файл «${state.name}»`
    case 'idle':
      return ''
  }
}

/** «PPV-073 · мастер», «FYP-0412 версия 2 · выданная копия · Fansly 2 12.08». */
function matchLine(match: FileMatch): string {
  const version = match.version && match.version > 1 ? ` версия ${match.version}` : ''
  const issued = match.issued
    ? ` · ${[match.issued.label, `${match.issued.on.slice(8, 10)}.${match.issued.on.slice(5, 7)}`].filter(Boolean).join(' ')}`
    : ''
  const head = match.item_id ? `${match.item_id}${version}` : match.title
  return `${head} · ${match.what}${issued}`
}

/**
 * Итог поиска по файлу под строкой: «Этот файл: FYP-0412 версия 2 · Fansly 2 12.08» и
 * остальные совпадения строками со ссылкой на объект, или «Такого файла нет».
 */
export function FileSearchPanel({
  state,
  model,
  onOpen,
  onClose,
}: {
  state: FileSearchState
  model: ModelCode
  onOpen: (id: ItemId) => void
  onClose: () => void
}) {
  if (state.kind !== 'done' && state.kind !== 'failed') {
    return null
  }
  const matches = state.kind === 'done' ? state.result.matches : []
  const [first, ...rest] = matches
  return (
    <div
      role="dialog"
      aria-label="Поиск по файлу"
      data-model={model}
      className="absolute inset-x-0 top-full z-50 flex flex-col gap-1 rounded-b-xl border-border border-t bg-popover p-3 shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        {state.kind === 'failed' ? (
          <p className="text-destructive">Хэш не посчитался — попробуйте ещё раз</p>
        ) : first?.item_id ? (
          <Button
            variant="link"
            size="inline"
            className="h-auto justify-start whitespace-normal text-left text-base"
            onClick={() => onOpen(first.item_id as ItemId)}
          >
            {state.result.text}
          </Button>
        ) : (
          <p className="text-base">{state.result.text}</p>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Закрыть" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {rest.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {rest.slice(0, 6).map((match) => (
            <li key={JSON.stringify(match)} className="text-sm">
              {match.item_id ? (
                <button
                  type="button"
                  className="text-left text-muted-foreground hover:text-foreground"
                  onClick={() => onOpen(match.item_id as ItemId)}
                >
                  {matchLine(match)}
                </button>
              ) : (
                <span className="text-muted-foreground">{matchLine(match)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
