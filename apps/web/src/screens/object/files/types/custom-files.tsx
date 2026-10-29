import { useObjectPage } from '../../object-context'
import { FilesScroll } from '../files-scroll'
import { FramesSection } from '../frames-section'
import { MasterSection } from '../master-section'
import { byPosition } from '../ordered-files'
import { PhotosSection } from '../photos-section'

/**
 * Кастом (DESIGN §4.5): мастер и версии после правок — прежние бледнее, «до правки 20.09»;
 * «Кадры мастера»; фото-части заказа. У фото-кастома — только фото.
 */
export function CustomFiles() {
  const { detail } = useObjectPage()
  const photos = byPosition(detail.files.filter((file) => file.role === 'photo'))
  const hasMaster = detail.files.some((file) => file.role === 'master')
  return (
    <FilesScroll>
      {hasMaster ? (
        <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
          <MasterSection title="Мастер" showVersions />
          <FramesSection />
        </div>
      ) : null}
      {photos.length > 0 ? <PhotosSection title="Фото" files={photos} numbered sortable /> : null}
    </FilesScroll>
  )
}
