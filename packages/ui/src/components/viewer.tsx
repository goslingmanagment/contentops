import { ChevronLeftIcon, ChevronRightIcon, InfoIcon, XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type KeyboardEvent, type ReactNode, type RefObject, useRef, useState } from 'react'
import { isTypingTarget } from '../lib/platform'
import { Button } from './button'
import { DarkSurface } from './dark-surface'
import type { TimelineSegment } from './timeline-track'
import { Filmstrip } from './viewer/filmstrip'
import { FrameCompare } from './viewer/frame-compare'
import { ShutterCompare } from './viewer/shutter-compare'
import { VideoControls } from './viewer/video-controls'
import type { ViewerFile } from './viewer/viewer-file'
import { MediaFrame, MediaNotice, MediaStill, ViewerPhoto } from './viewer/viewer-media'

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
  /** Мастер ещё обрабатывается: постер и «Превью собирается · 40 %» (0–100). */
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

/** Что сейчас на сцене: файл и его превью. Смена — новый `<video>` и сброс хода. */
function mediaKeyOf(file: ViewerFile | undefined): string {
  return file ? `${file.seed}\n${file.src ?? ''}` : ''
}

/**
 * Просмотр (DESIGN §3.5): чёрный экран на весь размер, стрелки 56 по бокам, лента кадров
 * у фото, управление у видео. Играет превью `preview.mp4`, `<video>` на странице один; фото —
 * превью 2048 поверх миниатюры. `←` `→` — соседний файл, `Space` — пауза, `i` — сведения,
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
  const [mediaDuration, setMediaDuration] = useState<number | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const file = files[index]
  const mediaKey = mediaKeyOf(file)
  const [shown, setShown] = useState({ key: mediaKey, start: startSeconds })
  if (shown.key !== mediaKey || shown.start !== startSeconds) {
    setShown({ key: mediaKey, start: startSeconds })
    setPlaying(false)
    setPosition(startSeconds ?? 0)
    if (shown.key !== mediaKey) {
      setMediaDuration(undefined)
      setFailed(false)
    }
  }
  const contentRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasPrevious = index > 0
  const hasNext = index < files.length - 1
  const playable = file?.type === 'video' && typeof file.src === 'string' && !failed

  const goTo = (next: number) => onIndexChange(next)

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) {
      return
    }
    if (video.paused || video.ended) {
      void video.play().catch(() => setPlaying(false))
    } else {
      video.pause()
    }
  }

  const seek = (seconds: number) => {
    setPosition(seconds)
    const video = videoRef.current
    if (video) {
      video.currentTime = seconds
    }
  }

  const retry = () => {
    setFailed(false)
    setAttempt((value) => value + 1)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // Ползунок позиции — не поле ввода: `Space` и там ставит на паузу.
    const onSlider = event.target instanceof HTMLInputElement && event.target.type === 'range'
    if (isTypingTarget(event.target) && !(onSlider && event.code === 'Space')) {
      return
    }
    const actionsByCode: Record<string, (() => void) | undefined> = {
      ArrowLeft: hasPrevious ? () => goTo(index - 1) : undefined,
      ArrowRight: hasNext ? () => goTo(index + 1) : undefined,
      KeyI: info ? () => setInfoOpen((value) => !value) : undefined,
      Space: playable && !compare ? togglePlay : undefined,
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
                    <MediaFrame file={file}>
                      {file.type === 'video' ? (
                        <>
                          <MediaStill file={file} />
                          {playable ? (
                            <ViewerVideo
                              key={`${mediaKey}\n${attempt}\n${startSeconds ?? ''}`}
                              file={file}
                              videoRef={videoRef}
                              startSeconds={startSeconds}
                              onToggle={togglePlay}
                              onPlayingChange={setPlaying}
                              onTime={setPosition}
                              onDuration={setMediaDuration}
                              onFailed={() => setFailed(true)}
                            />
                          ) : null}
                        </>
                      ) : (
                        <ViewerPhoto
                          key={`${mediaKey}\n${attempt}`}
                          file={file}
                          onFailed={() => setFailed(true)}
                        />
                      )}
                      <MediaNotice
                        file={file}
                        progress={previewProgress}
                        failed={failed}
                        onRetry={retry}
                      />
                    </MediaFrame>
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
                  {file.type === 'video' ? (
                    <VideoControls
                      durationSeconds={file.durationSeconds ?? mediaDuration ?? 0}
                      positionSeconds={position}
                      playing={playing}
                      onPlayingChange={togglePlay}
                      onSeek={seek}
                      disabled={!playable}
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

interface ViewerVideoProps {
  file: ViewerFile
  videoRef: RefObject<HTMLVideoElement | null>
  startSeconds: number | undefined
  onToggle: () => void
  onPlayingChange: (playing: boolean) => void
  onTime: (seconds: number) => void
  onDuration: (seconds: number) => void
  onFailed: () => void
}

/**
 * Превью видео (SPEC §9.3 `preview.mp4`): своё управление снизу, без встроенного; нажатие на
 * кадр — пауза. Постер — первый кадр, пока данные не пришли.
 */
function ViewerVideo({
  file,
  videoRef,
  startSeconds,
  onToggle,
  onPlayingChange,
  onTime,
  onDuration,
  onFailed,
}: ViewerVideoProps) {
  return (
    // biome-ignore lint/a11y/useMediaCaption: превью съёмок без речи для субтитров; управление — кнопками и `Space`.
    <video
      ref={videoRef}
      src={file.src ?? undefined}
      poster={file.poster ?? file.thumb ?? undefined}
      preload="metadata"
      playsInline
      onClick={onToggle}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget
        if (Number.isFinite(video.duration)) {
          onDuration(video.duration)
        }
        if (startSeconds !== undefined && startSeconds > 0) {
          video.currentTime = startSeconds
        }
      }}
      onPlay={() => onPlayingChange(true)}
      onPause={() => onPlayingChange(false)}
      onEnded={() => onPlayingChange(false)}
      onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
      onError={onFailed}
      className="absolute inset-0 size-full cursor-pointer object-contain"
    />
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
