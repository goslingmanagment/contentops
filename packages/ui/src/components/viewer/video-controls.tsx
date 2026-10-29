import { formatDuration } from '@contentops/contracts/format'
import { PauseIcon, PlayIcon } from 'lucide-react'
import { Button } from '../button'
import { segmentAt, type TimelineSegment, TimelineTrack } from '../timeline-track'

interface VideoControlsProps {
  durationSeconds: number
  positionSeconds: number
  playing: boolean
  onPlayingChange: (playing: boolean) => void
  onSeek: (seconds: number) => void
  /** Хронология, если она внесена: дорожка отрезков над управлением. */
  timeline?: readonly TimelineSegment[]
}

/**
 * Управление видео: пауза, дорожка и время, над ними — хронология, если она есть.
 * Играет превью, `<video>` на странице один.
 */
export function VideoControls({
  durationSeconds,
  positionSeconds,
  playing,
  onPlayingChange,
  onSeek,
  timeline,
}: VideoControlsProps) {
  const segment = timeline ? segmentAt(timeline, positionSeconds) : undefined
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4">
      {timeline && timeline.length > 0 ? (
        <div className="flex items-center gap-3 pl-12">
          <TimelineTrack
            durationSeconds={durationSeconds}
            segments={timeline}
            positionSeconds={positionSeconds}
            onSeek={onSeek}
            className="flex-1"
          />
          <span className="w-40 shrink-0 truncate text-muted-foreground text-sm">
            {segment?.label}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          variant="bar"
          size="icon"
          aria-label={playing ? 'Пауза' : 'Играть'}
          onClick={() => onPlayingChange(!playing)}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <input
          type="range"
          min={0}
          max={durationSeconds}
          value={positionSeconds}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="Позиция"
          className="h-1 flex-1 cursor-pointer accent-foreground"
        />
        <span className="shrink-0 text-muted-foreground text-sm tabular-nums">
          {formatDuration(positionSeconds)} / {formatDuration(durationSeconds)}
        </span>
      </div>
    </div>
  )
}
