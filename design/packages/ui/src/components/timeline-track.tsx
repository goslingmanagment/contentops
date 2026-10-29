import { formatDuration } from '@contentops/contracts/format'
import { cn } from 'cn'

export interface TimelineSegment {
  /** Начало отрезка, секунды. */
  start: number
  /** «торт и свечи», «бельё». */
  label: string
}

interface TimelineTrackProps {
  durationSeconds: number
  segments: readonly TimelineSegment[]
  /** Где сейчас просмотр: тонкая метка поверх дорожки. */
  positionSeconds?: number
  /** Нажатие на отрезок — просмотр с его начала. */
  onSeek?: (seconds: number) => void
  className?: string
}

interface TrackPart extends TimelineSegment {
  end: number
}

function partsOf(segments: readonly TimelineSegment[], duration: number): TrackPart[] {
  const sorted = [...segments].sort((left, right) => left.start - right.start)
  return sorted.map((segment, index) => ({
    ...segment,
    end: sorted[index + 1]?.start ?? duration,
  }))
}

/**
 * Дорожка хронологии (DESIGN §4.4, §4.20): отрезки по длительности, у каждого своё
 * начало. В объекте — под полем «Хронология», в просмотре — над управлением видео.
 * Цвета берутся из токенов, поэтому на тёмном просмотре дорожка светлая.
 */
export function TimelineTrack({
  durationSeconds,
  segments,
  positionSeconds,
  onSeek,
  className,
}: TimelineTrackProps) {
  const duration = Math.max(1, durationSeconds)
  const parts = partsOf(segments, duration)
  const marker =
    positionSeconds === undefined ? null : Math.min(100, (positionSeconds / duration) * 100)
  return (
    <div data-slot="timeline-track" className={cn('relative h-2 w-full', className)}>
      <ol aria-label="Хронология" className="flex size-full gap-0.5">
        {parts.map((part, index) => {
          const title = `${formatDuration(part.start)} — ${part.label}`
          const tone = index % 2 === 0 ? 'bg-line-strong' : 'bg-secondary-hover'
          return (
            <li
              key={`${part.start}-${part.label}`}
              className="flex h-full min-w-1"
              style={{ width: `${((part.end - part.start) / duration) * 100}%` }}
            >
              {onSeek ? (
                <button
                  type="button"
                  title={title}
                  aria-label={title}
                  onClick={() => onSeek(part.start)}
                  className={cn(
                    'size-full rounded-full transition-colors duration-120 hover:bg-ink-3',
                    tone,
                  )}
                />
              ) : (
                <span title={title} className={cn('size-full rounded-full', tone)} />
              )}
            </li>
          )
        })}
      </ol>
      {marker === null ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-1 -bottom-1 w-0.5 rounded-full bg-foreground"
          style={{ left: `${marker}%` }}
        />
      )}
    </div>
  )
}

/** Отрезок, в котором сейчас просмотр: подпись рядом со временем. */
export function segmentAt(
  segments: readonly TimelineSegment[],
  seconds: number,
): TimelineSegment | undefined {
  return [...segments]
    .sort((left, right) => left.start - right.start)
    .filter((segment) => segment.start <= seconds)
    .at(-1)
}
