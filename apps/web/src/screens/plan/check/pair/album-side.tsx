import { Button } from '@contentops/ui/components/button'
import { CopyIcon } from 'lucide-react'
import { useCopy } from '@/actions/use-copy'

interface AlbumSideProps {
  /** «SXT-005 Розовые стринги». */
  album: string
  /** Что Hub видит в альбоме: «В альбоме файл от 12.08, строка от 20.09». */
  fact: string | null
}

/**
 * Сторона платформы у vault (DESIGN §4.15): имя альбома с «Копировать» и что в нём нашёл
 * обход Hub. Картинок из альбома нет.
 */
export function AlbumSide({ album, fact }: AlbumSideProps) {
  const copy = useCopy()
  return (
    <>
      <p className="text-base">
        Альбом «{album}»
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Копировать имя альбома"
          onClick={() => void copy(album, 'Имя альбома скопировано')}
          className="ml-1 align-middle"
        >
          <CopyIcon />
        </Button>
      </p>
      {fact ? <p className="text-base">{fact}</p> : null}
    </>
  )
}
