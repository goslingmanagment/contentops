import { useState } from 'react'
import type { ViewerFile } from './viewer-file'
import { ViewerMedia } from './viewer-media'

interface ShutterCompareProps {
  left: ViewerFile
  right: ViewerFile
  leftLabel: string
  rightLabel: string
}

/** Сравнение двух фото «шторкой»: обе половины на одном месте и в одном масштабе. */
export function ShutterCompare({ left, right, leftLabel, rightLabel }: ShutterCompareProps) {
  const [split, setSplit] = useState(50)
  return (
    <div className="relative flex size-full flex-col items-center justify-center gap-4">
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]">
        <div className="relative">
          <ViewerMedia file={left} />
          <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
            <ViewerMedia file={right} />
          </div>
          <span
            aria-hidden
            className="absolute inset-y-0 w-0.5 bg-foreground"
            style={{ left: `${split}%` }}
          />
          <span className="absolute top-2 left-2 rounded-sm bg-scrim px-1.5 text-2xs text-scrim-foreground">
            {leftLabel}
          </span>
          <span className="absolute top-2 right-2 rounded-sm bg-scrim px-1.5 text-2xs text-scrim-foreground">
            {rightLabel}
          </span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(event) => setSplit(Number(event.target.value))}
        aria-label={`Шторка: ${leftLabel} слева, ${rightLabel} справа`}
        className="w-80 accent-foreground"
      />
    </div>
  )
}
