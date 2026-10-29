import { type ItemFile, LIFE_ASSIGNMENT_LABEL } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { useObjectPage } from '../../object-context'
import { FilesScroll } from '../files-scroll'
import { byPosition } from '../ordered-files'
import { PhotosSection } from '../photos-section'

/** Чип назначения — у кадров; видео лайфа назначения не получают. */
function assignmentMark(file: ItemFile) {
  if (file.role !== 'photo') {
    return null
  }
  return (
    <Badge variant="scrim">{file.assignment ? LIFE_ASSIGNMENT_LABEL[file.assignment] : '—'}</Badge>
  )
}

/**
 * Лайф (DESIGN §4.5): сетка кадров, на каждом внизу чип назначения «лента / чаты / оба /
 * —». Выделить → в полосе «В ленту», «В чаты», «Оба». «В чаты» ставит кадр в «Ещё не
 * залито» vault страниц.
 */
export function LifeFiles() {
  const { detail } = useObjectPage()
  const photos = byPosition(detail.files.filter((file) => file.role === 'photo'))
  const clips = detail.files.filter((file) => file.role === 'clip')
  const unassigned = photos.filter((file) => file.assignment === null).length
  return (
    <FilesScroll>
      <PhotosSection
        title="Кадры"
        files={[...photos, ...clips]}
        note={unassigned > 0 ? `без назначения ${unassigned}` : undefined}
        marks={assignmentMark}
      />
    </FilesScroll>
  )
}
