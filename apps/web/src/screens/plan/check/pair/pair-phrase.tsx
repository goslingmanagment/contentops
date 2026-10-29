import type { CheckCase } from '@contentops/contracts'
import { cn } from '@contentops/ui/lib/utils'

interface MatchPhraseProps {
  text: string
  /** `false` — красным и с «≠»; `null` — без оценки, просто состав. */
  matches: boolean | null
  className?: string
}

/** Фраза сравнения: «видео 0:09 — совпадает» или красное «≠ видео 0:10 и 0:07 — не совпадает». */
export function MatchPhrase({ text, matches, className }: MatchPhraseProps) {
  const differs = matches === false
  return (
    <p className={cn('text-base tabular-nums', differs && 'text-destructive', className)}>
      {differs ? <span aria-hidden>≠ </span> : null}
      {text}
    </p>
  )
}

/**
 * Одна фраза пары от сервера (DESIGN §4.15): «Пост 03:06 (+6 мин) · видео 0:09 —
 * совпадает» или «≠ … видео 0:09 и 0:11 — не совпадает» красным. Без фразы — ничего.
 */
export function PairPhrase({ entry }: { entry: CheckCase }) {
  if (!entry.pair_phrase) {
    return null
  }
  return <MatchPhrase text={entry.pair_phrase} matches={entry.pair_matches} />
}
