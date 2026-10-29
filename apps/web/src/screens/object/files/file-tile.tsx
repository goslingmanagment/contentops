import type { FileState } from '@contentops/contracts'
import { formatPercent } from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { Progress } from '@contentops/ui/components/progress'
import { type CoverAspect, CoverLabel, Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import type { ReactNode } from 'react'
import type { FileCover } from './file-thumb'

export interface FileTileProps {
  cover: FileCover
  /** Подпись для чтения с экрана и галочки: «фото 7», «мастер». */
  label: string
  /** Ширина миниатюры: фото 98, кадры 82, мастер 148 (DESIGN §7.6). */
  width: number
  aspect: CoverAspect
  /** Кадр другой пропорции вписывается целиком на `--muted`. */
  mediaAspect?: CoverAspect
  selected: boolean
  onSelectedChange?: (selected: boolean) => void
  /** Номер в порядке для заливки — слева сверху. */
  number?: number
  durationSeconds?: number
  /** Метки слева снизу: «обр.», «лента», «extra». */
  marks?: ReactNode
  /** Знак слева сверху: «отобран» у сета. */
  corner?: ReactNode
  /** Файл ещё готовится на сервере: «сжимается 62 %», «проверяется». */
  state?: FileState
  /** Кольцо долгой операции над этим файлом (202) — `PendingRing`. */
  pending?: ReactNode
  /** Прежняя версия бледнее. */
  dimmed?: boolean
  /** Под миниатюрой: «Мастер · 13:24», таймкод кадра, ID источника. */
  caption?: ReactNode
  /** Стопка версий за мастером (§8, `VersionStack`). */
  stacked?: boolean
  versionCount?: number
  checkSide?: 'left' | 'right'
}

/**
 * Файл внутри объекта (DESIGN §4.4–4.5): миниатюра нужной пропорции, номер, метки и
 * галочка выбора при наведении. Плитка не двигается и не растёт; выделенная — рамка 2 px
 * `--primary` и видимая галочка.
 */
export function FileTile({
  cover,
  label,
  width,
  aspect,
  mediaAspect,
  selected,
  onSelectedChange,
  number,
  durationSeconds,
  marks,
  corner,
  state,
  pending,
  dimmed = false,
  caption,
  stacked = false,
  versionCount,
  checkSide = 'right',
}: FileTileProps) {
  return (
    <div
      data-selected={selected}
      className="group/tile flex select-none flex-col gap-1.5 rounded-xl p-1 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint data-[selected=true]:ring-2 data-[selected=true]:ring-primary data-[selected=true]:ring-inset"
      style={{ width: width + 8 }}
    >
      <div className={cn('relative', stacked && 'mt-1 mr-1')}>
        {stacked ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 bottom-1 left-1 rounded-lg border border-line-strong bg-muted"
          />
        ) : null}
        <Thumb
          seed={cover.seed}
          kind={cover.kind}
          family={cover.family}
          frame={cover.frame}
          aspect={aspect}
          mediaAspect={mediaAspect}
          durationSeconds={state?.kind === 'processing' ? undefined : durationSeconds}
          versionCount={versionCount}
          className={cn('transition-opacity duration-120', dimmed && 'opacity-55')}
          overlay={
            <>
              {number === undefined ? null : (
                <CoverLabel className="top-1.5 left-1.5">{number}</CoverLabel>
              )}
              {corner ? <span className="absolute top-1.5 left-1.5">{corner}</span> : null}
              {marks ? (
                <span className="absolute right-1.5 bottom-1.5 flex gap-1">{marks}</span>
              ) : null}
              <SelectCheck
                label={label}
                selected={selected}
                side={checkSide}
                onSelectedChange={onSelectedChange}
              />
              {state?.kind === 'processing' ? <ProcessingVeil state={state} /> : null}
              {pending}
            </>
          }
        />
      </div>
      {caption ? <div className="flex min-w-0 flex-col px-0.5">{caption}</div> : null}
    </div>
  )
}

interface SelectCheckProps {
  label: string
  selected: boolean
  side: 'left' | 'right'
  onSelectedChange?: (selected: boolean) => void
}

/** Галочка выбора без открытия: видна при наведении и у выделенного (§3.3). */
function SelectCheck({ label, selected, side, onSelectedChange }: SelectCheckProps) {
  if (!onSelectedChange) {
    return null
  }
  return (
    <span
      className={cn(
        'absolute top-1.5 flex size-7 items-center justify-center rounded-md bg-background opacity-0 transition-opacity duration-120 group-hover/tile:opacity-100 group-data-[selected=true]/tile:opacity-100',
        side === 'right' ? 'right-1.5' : 'left-1.5',
      )}
    >
      <Checkbox
        checked={selected}
        aria-label={`Выбрать «${label}»`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCheckedChange={(checked) => onSelectedChange(checked === true)}
      />
    </span>
  )
}

/** «сжимается 62 %» с тонкой полоской — на самой плитке, пока файл готовится (§4.4). */
function ProcessingVeil({ state }: { state: Extract<FileState, { kind: 'processing' }> }) {
  const text =
    state.progress === null ? state.label : `${state.label} ${formatPercent(state.progress)}`
  return (
    <span className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-scrim px-2 pt-1.5 pb-2 text-scrim-foreground text-xs tabular-nums">
      {text}
      {state.progress === null ? null : (
        <Progress value={state.progress * 100} aria-label={text} className="h-0.5 bg-scrim" />
      )}
    </span>
  )
}
