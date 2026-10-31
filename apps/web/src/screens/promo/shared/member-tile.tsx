import type { CollectionMember } from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { Thumb } from '@contentops/ui/components/thumb'
import { TILE_MIN_WIDTH } from '@/screens/library/shared/collection-layout'
import { memberCover } from './member-cover'

/** Ячейка плитки: вертикальная 3:4 или горизонтальная 16:9 у подборок YouTube. */
export type MemberCell = '3:4' | '16:9'

interface MemberTileProps {
  member: CollectionMember
  selected: boolean
  cell?: MemberCell
  /** «02.09 передавали Coraline Red»; `null` — строка пустая, место под неё держится. */
  handed: string | null
  /** Галочка выбора без открытия; у «Только чтение» её нет. */
  onSelectedChange?: (selected: boolean) => void
}

const PADDING = 8
const GAP = 8
const TEXT_HEIGHT = 18 + 16

const CELL_RATIO: Record<MemberCell, number> = { '3:4': 3 / 4, '16:9': 16 / 9 }

/**
 * Сетка материалов: плитка 3:4 — та же, что в разделах Библиотеки (≈120 × 160, §7.6), с тем
 * же промежутком; кадры YouTube 16:9 — шире, чтобы не мельчить.
 */
export const MEMBER_GRID: Record<MemberCell, { minColumnWidth: number; gap: number }> = {
  '3:4': { minColumnWidth: TILE_MIN_WIDTH.tile, gap: 16 },
  '16:9': { minColumnWidth: 232, gap: 16 },
}

/** Высота ячейки: обложка по ширине, ID и строка «передавали» — место отведено всегда. */
export function memberTileHeight(cellWidth: number, cell: MemberCell = '3:4'): number {
  const cover = (cellWidth - PADDING * 2) / CELL_RATIO[cell]
  return Math.ceil(PADDING * 2 + cover + GAP + TEXT_HEIGHT)
}

/**
 * Материал промо (DESIGN §4.17, §7.6): стандартная плитка с «▶ 0:15» на обложке (кадр 16:9
 * среди вертикальных вписан), под ней ID исходного объекта и серым «02.09 передавали
 * Coraline Red». Плитка не двигается и не растёт: наведение — подложка, выделение — рамка
 * 2 px и видимая галочка.
 */
export function MemberTile({
  member,
  selected,
  cell = '3:4',
  handed,
  onSelectedChange,
}: MemberTileProps) {
  const cover = memberCover(member.thumb)
  return (
    <div
      data-selected={selected}
      className="group/tile flex h-full min-w-0 flex-col gap-2 rounded-xl p-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint data-[selected=true]:ring-2 data-[selected=true]:ring-primary data-[selected=true]:ring-inset"
    >
      <Thumb
        seed={cover.seed}
        kind={cover.kind}
        aspect={cell}
        mediaAspect={cover.mediaAspect}
        src={cover.src}
        durationSeconds={member.duration_s ?? undefined}
        overlay={
          onSelectedChange ? (
            <span className="absolute top-1.5 left-1.5 flex size-7 items-center justify-center rounded-md bg-background opacity-0 transition-opacity duration-120 group-hover/tile:opacity-100 group-data-[selected=true]/tile:opacity-100">
              <Checkbox
                checked={selected}
                aria-label={`Выбрать ${member.item_id}`}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onCheckedChange={(checked) => onSelectedChange(checked === true)}
              />
            </span>
          ) : null
        }
      />
      <div className="flex min-w-0 flex-col px-0.5">
        <p className="truncate text-sm tabular-nums">
          {member.item_id}
          {member.media === 'photo' ? <span className="text-ink-3"> · фото</span> : null}
        </p>
        <p title={handed ?? undefined} className="h-4 truncate text-ink-3 text-xs tabular-nums">
          {handed}
        </p>
      </div>
    </div>
  )
}
