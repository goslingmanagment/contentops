import { ChevronLeftIcon, ChevronRightIcon, InfoIcon, XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react'
import { isTypingTarget } from '../lib/platform'
import { Button } from './button'
import { DarkSurface } from './dark-surface'
import { ProgressWord } from './progress-word'
import type { TimelineSegment } from './timeline-track'
import { Filmstrip } from './viewer/filmstrip'
import { FrameCompare } from './viewer/frame-compare'
import { ShutterCompare } from './viewer/shutter-compare'
import { VideoControls } from './viewer/video-controls'
import type { ViewerFile } from './viewer/viewer-file'
import { ViewerMedia } from './viewer/viewer-media'

export type { ViewerFile }

export interface ViewerCompare {
  left: ViewerFile
  right: ViewerFile
  leftLabel: string
  rightLabel: string
}

interface ViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** «PPV-073 · мастер v2 · 13:24». */
  title: string
  files: readonly ViewerFile[]
  index: number
  onIndexChange: (index: number) => void
  /** Справа сверху перед «ⓘ» и «×»: «Скачать ▾», «⋯». */
  actions?: ReactNode
  /** Сведения справа тёмной панелью 320, клавиша `i`. */
  info?: ReactNode
  /** Превью ещё нет: постер и «Превью собирается · 40 %». */
  previewProgress?: number
  /** Сравнение двух версий: фото — шторкой, видео — двумя лентами кадров. */
  compare?: ViewerCompare
  onCompareOpenAt?: (file: ViewerFile, seconds: number) => void
  /** С какой секунды открыть видео: кадр мастера, минута из поиска по хронологии. */
  startSeconds?: number
  /** Хронология видео: дорожка отрезков над управлением. */
  timeline?: readonly TimelineSegment[]
  /** Внизу слева: переключатель «v1 / v2» у кастома и PPV после правки. */
  corner?: ReactNode
}

/**
 * Просмотр (DESIGN §3.5): чёрный экран на весь размер, стрелки 56 по бокам, лента кадров
 * у фото, управление у видео. `←` `→` — соседний файл, `Space` — пауза, `i` — сведения,
 * `Esc` — выход.
 */
export function Viewer({
  open,
  onOpenChange,
  title,
  files,
  index,
  onIndexChange,
  actions,
  info,
  previewProgress,
  compare,
  onCompareOpenAt,
  startSeconds,
  timeline,
  corner,
}: ViewerProps) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(startSeconds ?? 0)
  const [appliedStart, setAppliedStart] = useState(startSeconds)
  if (appliedStart !== startSeconds) {
    setAppliedStart(startSeconds)
    setPosition(startSeconds ?? 0)
  }
  const contentRef = useRef<HTMLDivElement>(null)
  const file = files[index]
  const hasPrevious = index > 0
  const hasNext = index < files.length - 1

  const goTo = (next: number) => {
    setPlaying(false)
    setPosition(0)
    onIndexChange(next)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
      return
    }
    const actionsByCode: Record<string, (() => void) | undefined> = {
      ArrowLeft: hasPrevious ? () => goTo(index - 1) : undefined,
      ArrowRight: hasNext ? () => goTo(index + 1) : undefined,
      KeyI: info ? () => setInfoOpen((value) => !value) : undefined,
      Space: file?.type === 'video' ? () => setPlaying((value) => !value) : undefined,
    }
    const action = actionsByCode[event.code]
    if (action) {
      event.preventDefault()
      action()
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DarkSurface asChild>
          <DialogPrimitive.Content
            ref={contentRef}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              contentRef.current?.focus()
            }}
            onKeyDown={handleKeyDown}
            className="fixed inset-0 z-50 flex bg-viewer outline-none duration-160 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          >
            <div className="relative flex min-w-0 flex-1 flex-col">
              <header className="flex h-16 shrink-0 items-center gap-2 px-5">
                <DialogPrimitive.Title className="min-w-0 flex-1 truncate font-medium text-base">
                  {title}
                </DialogPrimitive.Title>
                {actions}
                {info ? (
                  <Button
                    variant="bar"
                    size="icon"
                    aria-label="Сведения"
                    aria-pressed={infoOpen}
                    onClick={() => setInfoOpen((value) => !value)}
                    className="aria-pressed:bg-accent"
                  >
                    <InfoIcon />
                  </Button>
                ) : null}
                <DialogPrimitive.Close asChild>
                  <Button variant="bar" size="icon" aria-label="Закрыть просмотр">
                    <XIcon />
                  </Button>
                </DialogPrimitive.Close>
              </header>
              <div className="relative flex min-h-0 flex-1 items-center justify-center px-24 pb-4">
                {compare ? (
                  <CompareStage compare={compare} onOpenAt={onCompareOpenAt} />
                ) : file ? (
                  <div className="flex size-full items-center justify-center [container-type:size]">
                    <div className="relative">
                      <ViewerMedia file={file} />
                      {previewProgress === undefined ? null : (
                        <div className="absolute inset-0 flex items-center justify-center bg-scrim">
                          <ProgressWord
                            label="Превью собирается ·"
                            value={previewProgress}
                            className="w-56 text-foreground"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                {compare ? null : (
                  <>
                    <StepButton
                      side="left"
                      disabled={!hasPrevious}
                      onClick={() => goTo(index - 1)}
                    />
                    <StepButton side="right" disabled={!hasNext} onClick={() => goTo(index + 1)} />
                  </>
                )}
              </div>
              {compare || !file ? null : (
                <footer className="relative flex min-h-24 shrink-0 items-center justify-center py-4">
                  {corner ? <div className="absolute bottom-6 left-5">{corner}</div> : null}
                  {file.type === 'video' && file.durationSeconds !== undefined ? (
                    <VideoControls
                      durationSeconds={file.durationSeconds}
                      positionSeconds={position}
                      playing={playing}
                      onPlayingChange={setPlaying}
                      onSeek={setPosition}
                      timeline={timeline}
                    />
                  ) : (
                    <Filmstrip files={files} index={index} onIndexChange={goTo} />
                  )}
                </footer>
              )}
            </div>
            {info && infoOpen ? (
              <aside
                aria-label="Сведения"
                className="w-80 shrink-0 overflow-y-auto border-border border-l bg-card p-5 duration-160 animate-in fade-in-0 slide-in-from-right-4"
              >
                {info}
              </aside>
            ) : null}
          </DialogPrimitive.Content>
        </DarkSurface>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function StepButton({
  side,
  disabled,
  onClick,
}: {
  side: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}) {
  const Icon = side === 'left' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <Button
      variant="secondary"
      aria-label={side === 'left' ? 'Предыдущий файл' : 'Следующий файл'}
      disabled={disabled}
      onClick={onClick}
      className={`absolute top-1/2 size-14 -translate-y-1/2 rounded-full p-0 [&_svg]:size-6 ${side === 'left' ? 'left-5' : 'right-5'}`}
    >
      <Icon />
    </Button>
  )
}

function CompareStage({
  compare,
  onOpenAt,
}: {
  compare: ViewerCompare
  onOpenAt?: (file: ViewerFile, seconds: number) => void
}) {
  if (compare.left.type === 'video') {
    return <FrameCompare {...compare} onOpenAt={(file, seconds) => onOpenAt?.(file, seconds)} />
  }
  return <ShutterCompare {...compare} />
}
