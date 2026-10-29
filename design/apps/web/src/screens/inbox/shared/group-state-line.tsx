import { ProgressWord } from '@contentops/ui/components/progress-word'
import { type StatusKind, StatusSign } from '@contentops/ui/components/status-sign'
import { StatusWord } from '@contentops/ui/components/status-word'
import { cn } from '@contentops/ui/lib/utils'
import type { GroupStateView } from './group-texts'

interface GroupStateLineProps {
  view: GroupStateView
  /**
   * Длинная фраза переносится, а не обрезается: `start` — в панели, `center` — на плитке,
   * где знак стоит в строке перед словом и всё выровнено по центру (до двух строк).
   */
  wrap?: 'start' | 'center'
  className?: string
}

const WRAP_TONE: Record<StatusKind | 'none', string> = {
  done: 'text-foreground',
  turn: 'text-attention-ink',
  trouble: 'text-destructive',
  none: 'text-muted-foreground',
}

/**
 * Состояние группы одной строкой (DESIGN §5.3): ◆ и ▲ со словом, «готово» и «готовится»
 * серым; у «готовится» с долей — тонкая полоска 2 px под словом.
 */
export function GroupStateLine({ view, wrap, className }: GroupStateLineProps) {
  if (view.progress !== null) {
    return (
      <ProgressWord
        label={view.text}
        value={view.progress}
        text={view.text}
        className={cn('w-full max-w-48', className)}
      />
    )
  }
  if (wrap === 'center') {
    return (
      <p
        className={cn(
          'line-clamp-2 text-center text-sm transition-colors duration-160',
          WRAP_TONE[view.sign ?? 'none'],
          className,
        )}
      >
        {view.sign ? (
          <StatusSign kind={view.sign} className="mr-1.5 inline-block align-[-2px]" />
        ) : null}
        {view.text}
      </p>
    )
  }
  if (wrap === 'start') {
    return (
      <p
        className={cn(
          'flex items-start gap-1.5 text-sm transition-colors duration-160',
          WRAP_TONE[view.sign ?? 'none'],
          className,
        )}
      >
        {view.sign ? <StatusSign kind={view.sign} className="mt-0.5" /> : null}
        <span>{view.text}</span>
      </p>
    )
  }
  return (
    <StatusWord sign={view.sign ?? undefined} className={className}>
      {view.text}
    </StatusWord>
  )
}
