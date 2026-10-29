import { formatPercent, type StatusWord as StatusWordData } from '@contentops/contracts'
import { ProgressWord } from '@contentops/ui/components/progress-word'
import { StatusWord } from '@contentops/ui/components/status-word'

interface HandoffStatusProps {
  status: StatusWordData
  /** Ход сборки 0–1, пока передача готовится: слово с тонкой полоской (§5.1). */
  progress: number | null
  /**
   * В списках подрядчик и состав стоят своими колонками, поэтому слово короткое:
   * «готовится 40 %», «подготовлено», ✓ «передано», ▲ «не собралось».
   */
  short?: boolean
  className?: string
}

/**
 * Состояние передачи (DESIGN §5.7): «готовится · ≈2,6 ГБ · 40 %» с полоской,
 * «подготовлено», ✓ «передано · GaranTTeam 18.09», ▲ «не собралось · причина».
 */
export function HandoffStatus({ status, progress, short = false, className }: HandoffStatusProps) {
  if (status.sign === null && progress !== null && progress < 1) {
    const full = status.detail ? `${status.word} · ${status.detail}` : status.word
    return (
      <ProgressWord
        label={status.word}
        value={Math.round(progress * 100)}
        text={short ? `${status.word} ${formatPercent(progress)}` : full}
        className={className}
      />
    )
  }
  return (
    <StatusWord
      sign={status.sign ?? undefined}
      detail={short ? undefined : status.detail}
      className={className}
    >
      {status.word}
    </StatusWord>
  )
}
