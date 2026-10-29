import type { ItemFile } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { FilterToggleChip } from '@contentops/ui/components/filter-chips'
import { useObjectPage } from '../../object-context'
import { SextingFlagSchema } from '../../search'
import { FilesScroll } from '../files-scroll'
import { byPosition } from '../ordered-files'
import { PhotosSection } from '../photos-section'

function flagMarks(file: ItemFile) {
  return file.flags.length > 0
    ? file.flags.map((flag) => (
        <Badge key={flag} variant="scrim">
          {flag}
        </Badge>
      ))
    : null
}

/**
 * Секстинг (DESIGN §4.5): файлы по порядку с номерами (`pic01…`, `clip01…`), порядок
 * перетаскиванием; чипы «extra» и «optional» — фильтр. Под фильтром номера остаются
 * номерами всего секстинга, а порядок не меняется.
 */
export function SextingFiles() {
  const { detail, search, setSearch } = useObjectPage()
  const ordered = byPosition(detail.files)
  const flag = search.flag
  const shown = flag ? ordered.filter((file) => file.flags.includes(flag)) : ordered

  const chips = (
    <div className="flex items-center gap-1.5">
      {SextingFlagSchema.options.map((option) => (
        <FilterToggleChip
          key={option}
          label={option}
          pressed={flag === option}
          onPressedChange={(pressed) =>
            setSearch({ flag: pressed ? option : undefined }, { replace: true })
          }
        />
      ))}
    </div>
  )

  return (
    <FilesScroll>
      <PhotosSection
        title="Файлы"
        note="по порядку"
        files={shown}
        count={ordered.length}
        action={chips}
        numbered
        sortable={flag === undefined}
        marks={flagMarks}
        empty={<p className="py-6 text-muted-foreground">С меткой «{flag}» файлов нет</p>}
      />
    </FilesScroll>
  )
}
