import { formatDuration } from '@contentops/contracts/format'
import { Thumb } from '../thumb'
import type { ViewerFile, ViewerFrame } from './viewer-file'

interface FrameCompareProps {
  left: ViewerFile
  right: ViewerFile
  leftLabel: string
  rightLabel: string
  /** Нажатие на кадр открывает эту версию с этой секунды. */
  onOpenAt: (file: ViewerFile, seconds: number) => void
}

const FRAME_COUNT = 6

/**
 * Кадры версии: настоящие, на общих таймкодах версий (их подбирает сервер), а пока их нет —
 * равные шаги по длительности без картинок.
 */
function framesOf(
  file: ViewerFile,
  duration: number,
): readonly (ViewerFrame | { seconds: number; src?: undefined })[] {
  if (file.frames && file.frames.length > 0) {
    return file.frames
  }
  return Array.from({ length: FRAME_COUNT }, (_, index) => ({
    seconds: Math.round((duration * (index + 0.5)) / FRAME_COUNT),
  }))
}

/** Сравнение двух версий видео: две ленты кадров на одних таймкодах (DESIGN §3.5). */
export function FrameCompare({ left, right, leftLabel, rightLabel, onOpenAt }: FrameCompareProps) {
  const duration = Math.max(left.durationSeconds ?? 0, right.durationSeconds ?? 0)
  const rows = [
    { file: left, label: leftLabel },
    { file: right, label: rightLabel },
  ]
  return (
    <div className="flex flex-col gap-6">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-4">
          <span className="w-10 shrink-0 font-medium text-base">{row.label}</span>
          <div className="flex gap-2">
            {framesOf(row.file, duration).map((frame, index) => (
              <button
                key={`${index}:${frame.seconds}`}
                type="button"
                onClick={() => onOpenAt(row.file, frame.seconds)}
                aria-label={`${row.label} с ${formatDuration(frame.seconds)}`}
                className="flex flex-col items-center gap-1 rounded-md"
              >
                <Thumb
                  seed={row.file.seed}
                  kind={row.file.kind}
                  family={row.file.family}
                  aspect={row.file.aspect}
                  frame={index + 1}
                  src={frame.src}
                  showCaptions={false}
                  className="w-24 rounded-md"
                />
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatDuration(frame.seconds)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
