import type { CatalogEntry, ItemId } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@contentops/ui/components/input-group'
import { PanelMain } from '@contentops/ui/components/panel-pin'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { cn } from '@contentops/ui/lib/utils'
import { SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { useCurrentModel } from '@/shell/model/model-context'
import { compareComposition, compositionOf } from '../case-text'
import { CaseThumb } from '../case-thumb'
import type { CaseBodyProps } from './case-body'
import { OurSide, PairSides, PostSide } from './pair-sides'
import { useBindSuggestions } from './use-bind-suggestions'

interface SuggestionProps {
  entry: CatalogEntry
  picked: boolean
  onPick: () => void
}

function Suggestion({ entry, picked, onPick }: SuggestionProps) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={picked}
        onClick={onPick}
        className={cn(
          'flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120',
          picked ? 'bg-primary-tint' : 'hover:bg-accent',
        )}
      >
        <CaseThumb itemId={entry.id} surface="wall" size="mini" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base">
            <span className="text-ink-3 tabular-nums">{entry.id} · </span>
            {entry.title}
          </span>
          <span className="truncate text-ink-3 text-sm tabular-nums">{compositionOf(entry)}</span>
        </span>
      </button>
    </li>
  )
}

/** Пустое место слева, пока объект не выбран: пунктир размера нашей миниатюры. */
function NothingPicked() {
  return (
    <div className="flex aspect-9/16 h-40 items-center justify-center self-start rounded-lg border border-input border-dashed px-2 text-center text-ink-3 text-sm">
      Что это?
    </div>
  )
}

/**
 * Пост без плана (DESIGN §4.15): справа то, что видел Hub, слева выбор из каталога —
 * подсказки «Ещё не залито на Fansly 1 · по времени» и поиск; «Привязать» и «Не наше».
 * Выбранное сразу сравнивается с постом: «≠ видео 0:10 и 0:07 — не совпадает» красным.
 */
export function UnplannedBody({
  entry,
  account,
  canDecide,
  pending,
  onDecide,
  focusSearch,
}: CaseBodyProps) {
  const model = useCurrentModel()
  const post = entry.posts[0]
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<CatalogEntry | null>(null)
  const suggestions = useBindSuggestions(model.code, account, post, query)
  const busy = pending !== null
  const bind = (itemId: ItemId) => onDecide({ action: 'bind', entry, itemId })
  // Выбранное против поста: при расхождении «Привязать» теряет синий цвет — сначала глазами.
  const match = picked && post ? compareComposition(picked, post) : null

  return (
    <>
      <PairSides
        pageLabel={account.label}
        ours={picked ? <OurSide itemId={picked.id} entry={picked} /> : <NothingPicked />}
        theirs={post ? <PostSide post={post} pageLabel={account.label} match={match} /> : null}
      />
      {canDecide ? (
        <>
          <PanelMain>
            <Button
              variant={match?.matches === false ? 'outline' : 'default'}
              disabled={!picked || (busy && pending !== 'bind')}
              pending={pending === 'bind'}
              onClick={() => (picked ? bind(picked.id) : undefined)}
            >
              {picked ? `Привязать ${picked.id}` : 'Привязать'}
            </Button>
            <Button
              variant="outline"
              pending={pending === 'outside'}
              disabled={busy && pending !== 'outside'}
              onClick={() => onDecide({ action: 'outside', entry })}
            >
              Не наше
            </Button>
          </PanelMain>
          <div className="flex flex-col gap-2">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus={focusSearch}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  const first = suggestions.items?.[0]
                  if (event.key === 'Enter' && first) {
                    setPicked(first)
                  }
                }}
                placeholder="ID или название"
                aria-label="Найти в каталоге"
              />
            </InputGroup>
            {suggestions.title ? (
              <h3 className="px-2 text-ink-3 text-sm">{suggestions.title}</h3>
            ) : null}
            {suggestions.items === undefined ? (
              <ListRowSkeleton height={48} thumb="portrait" />
            ) : suggestions.items.length === 0 ? (
              <p className="px-2 text-base text-muted-foreground">Ничего не нашлось</p>
            ) : (
              <ul className="flex flex-col">
                {suggestions.items.map((candidate) => (
                  <Suggestion
                    key={candidate.id}
                    entry={candidate}
                    picked={picked?.id === candidate.id}
                    onPick={() => setPicked(candidate)}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </>
  )
}
