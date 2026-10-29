import type { CheckCase, PostSurface } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import type { Decision, PendingAction } from '../use-case-decisions'

interface PairDecisionProps {
  entry: CheckCase
  pending: PendingAction | null
  onDecide: (decision: Decision) => void
}

const SURFACES: readonly { value: PostSurface; label: string }[] = [
  { value: 'wall', label: 'Стена' },
  { value: 'fyp', label: 'Фуп' },
]

/**
 * Решение по одной паре: «Это оно» (синяя) и «Не то». У «стена или фуп?» — два равных
 * ответа без предвыбора; сам вопрос уже стоит словом в шапке панели. Кнопки — соседи в
 * строке `PanelMain`: раскладку задаёт закреплённый верх панели.
 */
export function PairDecision({ entry, pending, onDecide }: PairDecisionProps) {
  const busy = pending !== null
  if (entry.kind === 'surface') {
    return (
      <>
        {SURFACES.map((surface) => (
          <Button
            key={surface.value}
            variant="outline"
            disabled={busy}
            onClick={() =>
              onDecide({ action: 'confirm', entry, evidenceId: null, surface: surface.value })
            }
          >
            {surface.label}
          </Button>
        ))}
      </>
    )
  }
  const evidenceId = entry.posts[0]?.evidence_id ?? null
  return (
    <>
      <Button
        pending={pending === 'confirm'}
        disabled={busy && pending !== 'confirm'}
        onClick={() => onDecide({ action: 'confirm', entry, evidenceId })}
      >
        Это оно
      </Button>
      <Button
        variant="outline"
        pending={pending === 'reject'}
        disabled={busy && pending !== 'reject'}
        onClick={() => onDecide({ action: 'reject', entry, evidenceId })}
      >
        Не то
      </Button>
    </>
  )
}
