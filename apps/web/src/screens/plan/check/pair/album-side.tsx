import { Button } from '@contentops/ui/components/button'
import { CopyIcon } from 'lucide-react'
import { useActionToast } from '@/actions/action-toast-context'

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
  const toast = useActionToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(album)
      toast.show({ message: 'Имя альбома скопировано' })
    } catch (error) {
      toast.showFailure(error, { failed: 'Не скопировалось' })
    }
  }
  return (
    <>
      <p className="text-base">
        Альбом «{album}»
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Копировать имя альбома"
          onClick={() => void copy()}
          className="ml-1 align-middle"
        >
          <CopyIcon />
        </Button>
      </p>
      {fact ? <p className="text-base">{fact}</p> : null}
    </>
  )
}
