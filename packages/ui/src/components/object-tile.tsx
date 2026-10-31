import { cn } from 'cn'
import type { PointerEvent } from 'react'
import { Checkbox } from './checkbox'
import type { CoverFamily, CoverKind } from './cover/families'
import type { StatusKind } from './status-sign'
import { StatusSign } from './status-sign'
import { StatusWord } from './status-word'
import { Thumb } from './thumb'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/** Три вида раздела (DESIGN §3.2): крупная плитка, плитка, строка списка. */
export type ObjectTileView = 'large' | 'tile' | 'row'

export interface ObjectTileSign {
  kind: Exclude<StatusKind, 'done'>
  /** «в альбоме нет файла»: одно слово на состояние везде (§5.2). */
  label: string
  /** Подсказка при наведении на знак: «пропущено на OF VIP». По умолчанию — `label`. */
  hint?: string
}

export interface ObjectTileProps {
  view: ObjectTileView
  /** «PPV-073». */
  id: string
  title: string
  kind?: CoverKind
  coverFamily?: CoverFamily
  /** Настоящая миниатюра обложки; без неё — синтетическая. */
  coverSrc?: string
  durationSeconds?: number
  /** «22 фото», «22 файла» — если длительности нет. */
  countLabel?: string
  versionCount?: number
  /** Знак на белой пилюле, только если у объекта есть ◆ или ▲. */
  sign?: ObjectTileSign
  /** Добавка к строке ID: «Fansly 2 08.08» или «не видели на Fansly 2». */
  placementHint?: string
  /** Подсказка к строке ID, когда добавка сокращена: полный ответ со страницей. */
  placementTitle?: string
  /** Три серых колонки строки списка: длительность или кадры, дата прихода, где залито. */
  columns?: readonly [string, string, string]
  selected?: boolean
  /**
   * Полное название в подсказке у обрезанного многоточием. Выключается, когда у плитки
   * своя подсказка («Недавние»: причина при наведении), чтобы не всплывали обе.
   */
  titleHint?: boolean
  /** Галочка выбора без открытия (появляется при наведении). */
  onSelectedChange?: (selected: boolean) => void
  className?: string
}

// `break-words`: название из одного длинного слова (`Нейлоновые_колготки_и_каблуки`)
// переносится и обрезается многоточием, а не уходит за край плитки.
const titleClass: Record<ObjectTileView, string> = {
  large: 'h-10 text-base line-clamp-2 break-words',
  tile: 'h-9 text-sm line-clamp-2 break-words',
  row: 'truncate text-base',
}

/**
 * Объект каталога (DESIGN §4.2). Плитка не двигается и не растёт: наведение — подложка,
 * выделение — рамка 2 px и видимая галочка. Под название всегда две строки.
 */
export function ObjectTile(props: ObjectTileProps) {
  return props.view === 'row' ? <ObjectRow {...props} /> : <ObjectCard {...props} />
}

function ObjectCard({
  view,
  id,
  title,
  kind,
  coverFamily,
  coverSrc,
  durationSeconds,
  countLabel,
  versionCount,
  sign,
  placementHint,
  placementTitle,
  selected = false,
  titleHint = true,
  onSelectedChange,
  className,
}: ObjectTileProps) {
  return (
    <div
      data-slot="object-tile"
      data-view={view}
      data-selected={selected}
      className={cn(
        // `select-none`: `Shift`-щелчок выделяет диапазон плиток, а не текст страницы.
        'group/tile flex h-full min-w-0 select-none flex-col gap-2 rounded-xl p-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint data-[selected=true]:ring-2 data-[selected=true]:ring-primary data-[selected=true]:ring-inset',
        className,
      )}
    >
      <Thumb
        seed={id}
        kind={kind}
        family={coverFamily}
        src={coverSrc}
        durationSeconds={durationSeconds}
        countLabel={countLabel}
        versionCount={versionCount}
        overlay={
          <>
            <SelectCheck title={title} selected={selected} onSelectedChange={onSelectedChange} />
            {sign ? <SignPill sign={sign} compact={view === 'tile'} /> : null}
          </>
        }
      />
      <div className="flex min-w-0 flex-col px-0.5">
        <p className={titleClass[view]} title={titleHint ? title : undefined}>
          {title}
        </p>
        <p
          className={cn(
            'truncate text-muted-foreground tabular-nums',
            view === 'large' ? 'text-sm' : 'text-xs',
          )}
          title={placementHint ? placementTitle : undefined}
        >
          {id}
          {placementHint ? ` · ${placementHint}` : null}
        </p>
      </div>
    </div>
  )
}

function ObjectRow({
  id,
  title,
  kind,
  coverFamily,
  coverSrc,
  sign,
  columns,
  selected = false,
  titleHint = true,
  onSelectedChange,
  className,
}: ObjectTileProps) {
  return (
    <div
      data-slot="object-tile"
      data-view="row"
      data-selected={selected}
      className={cn(
        'group/tile flex h-13 min-w-0 select-none items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint',
        className,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <SelectCheck title={title} selected={selected} onSelectedChange={onSelectedChange} inline />
      </span>
      <Thumb
        seed={id}
        kind={kind}
        family={coverFamily}
        src={coverSrc}
        aspect="1:1"
        showCaptions={false}
        className="w-10 shrink-0 rounded-md"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className={titleClass.row} title={titleHint ? title : undefined}>
          {title}
        </p>
        <p className="flex min-w-0 items-center gap-2 text-ink-3 text-sm tabular-nums">
          <span className="shrink-0">{id}</span>
          {sign ? (
            <StatusWord sign={sign.kind} title={sign.hint ?? sign.label}>
              {sign.label}
            </StatusWord>
          ) : null}
        </p>
      </div>
      {columns ? (
        <div className="flex shrink-0 items-center gap-6 text-muted-foreground text-sm tabular-nums">
          <span className="w-20 truncate text-right" title={columns[0]}>
            {columns[0]}
          </span>
          <span className="w-20 truncate">{columns[1]}</span>
          <span className="w-44 truncate" title={columns[2]}>
            {columns[2]}
          </span>
        </div>
      ) : null}
    </div>
  )
}

interface SelectCheckProps {
  title: string
  selected: boolean
  onSelectedChange?: (selected: boolean) => void
  inline?: boolean
}

/**
 * Галочка выбора: видна при наведении и у выделенного. Щелчок по ней не открывает объект.
 * Плитка живёт в `listbox`, где по плиткам ходят стрелками, поэтому галочка — не остановка
 * `Tab` (`tabIndex=-1`): иначе `Tab` проходил бы по невидимой галочке каждой плитки.
 */
function SelectCheck({ title, selected, onSelectedChange, inline = false }: SelectCheckProps) {
  return (
    <span
      className={cn(
        'opacity-0 transition-opacity duration-120 group-hover/tile:opacity-100 group-data-[selected=true]/tile:opacity-100',
        !inline &&
          'absolute top-1.5 left-1.5 flex size-7 items-center justify-center rounded-md bg-background',
      )}
    >
      <Checkbox
        checked={selected}
        tabIndex={-1}
        aria-label={`Выбрать «${title}»`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCheckedChange={(checked) => onSelectedChange?.(checked === true)}
      />
    </span>
  )
}

/** Наведение на знак показывает его подсказку, а не подсказку всей плитки вокруг. */
function keepHintToSign(event: PointerEvent) {
  event.stopPropagation()
}

/**
 * Знак ◆ или ▲ на белой пилюле; при наведении отодвигается от галочки. На узкой плитке
 * (`compact`) — только знак, слово — в подсказке: сокращать слово нельзя, у состояния
 * одно слово на весь продукт (§5.2).
 */
function SignPill({ sign, compact }: { sign: ObjectTileSign; compact: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          onPointerMove={keepHintToSign}
          className={cn(
            'absolute top-1.5 left-1.5 inline-flex h-7 max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-full bg-background text-xs transition-[left,max-width] duration-120 group-hover/tile:left-10 group-hover/tile:max-w-[calc(100%-2.875rem)] group-data-[selected=true]/tile:left-10',
            compact ? 'w-7 justify-center' : 'px-2',
          )}
        >
          <StatusSign kind={sign.kind} label={sign.hint ?? sign.label} />
          {compact ? null : (
            <span
              className={cn(
                'truncate',
                sign.kind === 'turn' ? 'text-attention-ink' : 'text-destructive',
              )}
            >
              {sign.label}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{sign.hint ?? sign.label}</TooltipContent>
    </Tooltip>
  )
}

/** Высота ячейки для виртуальной сетки: обложка 3:4 по ширине плюс две строки названия и ID. */
export function objectTileHeight(view: ObjectTileView, cellWidth: number): number {
  if (view === 'row') {
    return 52
  }
  const padding = 8
  const cover = ((cellWidth - padding * 2) * 4) / 3
  const text = view === 'large' ? 40 + 18 : 36 + 16
  return Math.ceil(padding * 2 + cover + 8 + text)
}
