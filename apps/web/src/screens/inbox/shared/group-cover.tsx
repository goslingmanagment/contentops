import type { InboxGroup } from '@contentops/contracts'
import { Mosaic } from '@contentops/ui/components/mosaic'
import { Thumb } from '@contentops/ui/components/thumb'
import { FileArchiveIcon } from 'lucide-react'
import { groupMosaic } from './draft-cover'

/**
 * Обложка плитки группы (DESIGN §4.8, §7.6): мозаика первых кадров ≈211 × 132. Один файл
 * занимает всё место, а не треть с двумя пустыми ячейками. У архива, пока оглавления нет
 * (качается или не читается), — значок архива со словом, а не пустые серые ячейки.
 */
export function GroupCover({ group }: { group: InboxGroup }) {
  const tiles = groupMosaic(group)
  const [only] = tiles
  if (tiles.length === 0) {
    return (
      <div className="flex aspect-[211/132] flex-col items-center justify-center gap-1.5 rounded-lg bg-muted text-ink-3">
        <FileArchiveIcon aria-hidden className="size-8" strokeWidth={1.5} />
        <span className="text-sm">архив</span>
      </div>
    )
  }
  if (tiles.length === 1 && only) {
    return (
      <div className="relative aspect-[211/132] overflow-hidden rounded-lg">
        <Thumb
          fill
          seed={only.seed}
          src={only.src}
          kind={only.kind}
          aspect="16:9"
          durationSeconds={only.durationSeconds}
          countLabel={only.countLabel}
          className="rounded-none"
        />
      </div>
    )
  }
  return <Mosaic tiles={tiles} className="rounded-lg" />
}
