import { cn } from 'cn'
import { Thumb } from '../thumb'
import type { ViewerFile } from './viewer-file'

interface FilmstripProps {
  files: readonly ViewerFile[]
  index: number
  onIndexChange: (index: number) => void
}

/** Лента кадров 64 с номерами (DESIGN §3.5). */
export function Filmstrip({ files, index, onIndexChange }: FilmstripProps) {
  return (
    <div className="flex max-w-full justify-center gap-1.5 overflow-x-auto px-4 pb-1">
      {files.map((file, position) => (
        <button
          key={file.seed}
          type="button"
          aria-label={file.label ?? `Файл ${position + 1}`}
          aria-current={position === index ? 'true' : undefined}
          onClick={() => onIndexChange(position)}
          className={cn(
            'relative h-16 shrink-0 overflow-hidden rounded-md opacity-60 transition-opacity duration-120 hover:opacity-100 aria-[current=true]:opacity-100 aria-[current=true]:ring-2 aria-[current=true]:ring-foreground',
          )}
        >
          <Thumb
            seed={file.seed}
            kind={file.kind}
            family={file.family}
            aspect="3:4"
            mediaAspect={file.aspect}
            showCaptions={false}
            className="h-16 rounded-none"
          />
          <span className="absolute top-1 left-1 rounded-sm bg-scrim px-1 text-2xs text-scrim-foreground tabular-nums">
            {position + 1}
          </span>
        </button>
      ))}
    </div>
  )
}
