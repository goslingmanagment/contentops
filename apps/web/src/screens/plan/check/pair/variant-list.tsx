import type { CatalogEntry, CheckCase, HubPost } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { compareComposition } from '../case-text'
import type { Decision, PendingAction } from '../use-case-decisions'
import { PostSide } from './pair-sides'

interface VariantListProps {
  entry: CheckCase
  /** Наш объект: с ним сравнивается состав каждого поста. */
  ours: CatalogEntry | undefined
  pageLabel: string
  canDecide: boolean
  pending: PendingAction | null
  onDecide: (decision: Decision) => void
}

function byTime(left: HubPost, right: HubPost): number {
  return left.post_at.localeCompare(right.post_at)
}

/**
 * Несколько вариантов (DESIGN §4.15): карточки постов по времени, без предвыбора, у каждой
 * состав против нашего («22 фото — совпадает» или красное «≠») и «Это оно»; внизу «Ни один».
 */
export function VariantList({
  entry,
  ours,
  pageLabel,
  canDecide,
  pending,
  onDecide,
}: VariantListProps) {
  const busy = pending !== null
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {[...entry.posts].sort(byTime).map((post) => (
          <li
            key={post.evidence_id}
            className="flex items-start justify-between gap-3 rounded-xl border border-border p-3"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <PostSide
                post={post}
                pageLabel={pageLabel}
                match={ours ? compareComposition(ours, post) : null}
              />
            </div>
            {canDecide ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => onDecide({ action: 'confirm', entry, evidenceId: post.evidence_id })}
              >
                Это оно
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canDecide ? (
        <Button
          variant="outline"
          pending={pending === 'reject-all'}
          disabled={busy && pending !== 'reject-all'}
          onClick={() => onDecide({ action: 'reject', entry, evidenceId: null })}
          className="self-start"
        >
          Ни один
        </Button>
      ) : null}
    </div>
  )
}
