import { useObjectPage } from '../../object-context'
import { FilesScroll } from '../files-scroll'
import { FramesSection } from '../frames-section'
import { MasterSection } from '../master-section'
import { byPosition } from '../ordered-files'
import { PhotosSection } from '../photos-section'

/**
 * PPV (DESIGN §4.5): «Мастер и тизер», под ними «Кадры мастера» 5 × 2 (в широком окне —
 * рядом), ниже «Фото · 21 в порядке для заливки». Нет фото — строка о том, как их сделать.
 */
export function PpvFiles() {
  const { detail } = useObjectPage()
  const photos = byPosition(detail.files.filter((file) => file.role === 'photo'))
  return (
    <FilesScroll>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
        <MasterSection title="Мастер и тизер" teaserSlot />
        <FramesSection />
      </div>
      <PhotosSection
        title="Фото"
        note={photos.length > 0 ? 'в порядке для заливки' : undefined}
        files={photos}
        numbered
        sortable
        empty={
          <p className="flex min-h-16 items-center rounded-lg border border-input border-dashed px-4 text-muted-foreground">
            Фото нет · выделите кадры мастера → Сделать фото
          </p>
        }
      />
    </FilesScroll>
  )
}
