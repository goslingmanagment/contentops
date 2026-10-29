import { formatDuration } from '@contentops/contracts/format'
import { Thumb } from '../thumb'
import type { ViewerFile } from './viewer-file'

interface FrameCompareProps {
  left: ViewerFile
  right: ViewerFile
  leftLabel: string
  rightLabel: string
  /** Нажатие на кадр открывает эту версию с этой секунды. */
  onOpenAt: (file: ViewerFile, seconds: number) => void
}

const FRAME_COUNT = 6

/** Сравнение двух версий видео: две ленты кадров на одних таймкодах (DESIGN §3.5). */
export function FrameCompare({ left, right, leftLabel, rightLabel, onOpenAt }: FrameCompareProps) {
  const duration = Math.max(left.durationSeconds ?? 0, right.durationSeconds ?? 0)
  const timecodes = Array.from({ length: FRAME_COUNT }, (_, index) =>
    Math.round((duration * (index + 0.5)) / FRAME_COUNT),
  )
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
            {timecodes.map((seconds, frame) => (
              <button
                key={seconds}
                type="button"
                onClick={() => onOpenAt(row.file, seconds)}
                aria-label={`${row.label} с ${formatDuration(seconds)}`}
                className="flex flex-col items-center gap-1 rounded-md"
              >
                <Thumb
                  seed={row.file.seed}
                  kind={row.file.kind}
                  family={row.file.family}
                  aspect={row.file.aspect}
                  frame={frame + 1}
                  showCaptions={false}
                  className="w-24 rounded-md"
                />
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatDuration(seconds)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
