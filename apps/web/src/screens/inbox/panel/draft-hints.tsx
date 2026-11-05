import type { DraftHint, DraftState } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import type { CompareHint } from './decision-block'

/** Эти подсказки стоят в блоке решения, а не в списке подсказок. */
const IN_DECISION: ReadonlySet<DraftHint['kind']> = new Set([
  'other_model',
  'row_change',
  'import_doubt',
])

interface DraftHintsProps {
  hints: readonly DraftHint[]
  /** «Похоже на ролик» стоит в блоке решения, пока это и есть вопрос группы. */
  state: DraftState
  onCompare: (hint: CompareHint) => void
}

/**
 * Подсказки (DESIGN §4.8, п. 3): «Похоже на фото № 7 из сета 69 · Сравнить», «в имени
 * 15:37, в файле 15:12», совпадение с заказом. Подсказка не блокирует «Принять».
 */
export function DraftHints({ hints, state, onCompare }: DraftHintsProps) {
  const asked = state.kind === 'decision' && state.decision === 'video_copy'
  const shown = hints.filter(
    (hint) => !IN_DECISION.has(hint.kind) && !(asked && hint.kind === 'similar_video'),
  )
  if (shown.length === 0) {
    return null
  }
  return (
    <InfoSection title="Подсказки">
      <ul className="flex flex-col gap-1.5 text-sm">
        {shown.map((hint) => (
          <li key={`${hint.kind}-${'text' in hint ? hint.text : ''}`}>
            {hint.kind === 'similar' || hint.kind === 'similar_video' ? (
              <>
                {hint.kind === 'similar' ? hint.text : `${hint.text} · ${hint.similarity} %`}
                {' · '}
                <Button
                  variant="link"
                  size="inline"
                  className="text-sm"
                  onClick={() => onCompare(hint)}
                >
                  Сравнить
                </Button>
              </>
            ) : 'text' in hint ? (
              <span className="text-muted-foreground">{hint.text}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </InfoSection>
  )
}
