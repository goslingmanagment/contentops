import { Button } from '../../src/components/button'
import { DarkSurface } from '../../src/components/dark-surface'
import { DownloadButton } from '../../src/components/download-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../../src/components/dropdown-menu'
import { HotkeysHelp } from '../../src/components/hotkeys-help'
import { ItemMenuItems } from '../../src/components/item-menu'
import { GallerySection } from '../gallery-section'
import { downloadOptions, objectMenu } from './sample-menus'

/** Открытые меню и всплывашки: светлые и тёмные (в полосе выделения). */
export function MenusPage() {
  return (
    <GallerySection
      title="Меню и всплывашки (открыты)"
      note="пункт 40, радиус 12; опасные внизу за линией; в тёмной полосе меню тёмное"
    >
      <div className="grid h-150 grid-cols-[300px_360px_300px_1fr] items-start gap-6">
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Меню объекта</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <ItemMenuItems menu={objectMenu} />
          </DropdownMenuContent>
        </DropdownMenu>
        <div>
          <DownloadButton options={downloadOptions} onDownload={() => undefined} menuOpen />
        </div>
        <DarkSurface className="flex h-14 w-fit items-center rounded-2xl bg-bar px-2">
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="bar">Меню полосы</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <ItemMenuItems menu={objectMenu} />
            </DropdownMenuContent>
          </DropdownMenu>
        </DarkSurface>
        <div className="justify-self-end">
          <HotkeysHelp open />
        </div>
      </div>
    </GallerySection>
  )
}
