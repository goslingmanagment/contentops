import { useState } from 'react'
import { FolderTile } from '../../src/components/folder-tile'
import { ItemContextMenu } from '../../src/components/item-menu'
import { Mosaic } from '../../src/components/mosaic'
import { ObjectTile } from '../../src/components/object-tile'
import { GallerySection, Specimen } from '../gallery-section'
import { libraryFolders } from '../sample-folders'
import { objectMenu } from './sample-menus'

export function TilesPage() {
  const [selected, setSelected] = useState(true)
  return (
    <>
      <GallerySection
        title="Плитка объекта"
        note="крупная 176, плитка 120, строка 52; выделение — рамка и галочка"
      >
        <div className="flex flex-wrap items-start gap-4">
          <ItemContextMenu menu={objectMenu}>
            <div className="w-48">
              <ObjectTile
                view="large"
                id="PPV-073"
                title="День рождения, торт, кружево"
                kind="ppv"
                coverFamily="party"
                durationSeconds={804}
                versionCount={2}
              />
            </div>
          </ItemContextMenu>
          <div className="w-48">
            <ObjectTile
              view="large"
              id="PPV-074"
              title="Кристаллы и каблуки"
              kind="ppv"
              durationSeconds={581}
              sign={{ kind: 'turn', label: 'Hub нашёл похожее' }}
              placementHint="не видели на Fansly 2"
            />
          </div>
          <div className="w-48">
            <ObjectTile
              view="large"
              id="PPV-075"
              title="Коричневое кружево у зеркала"
              kind="ppv"
              durationSeconds={518}
              selected={selected}
              onSelectedChange={setSelected}
              placementHint="Fansly 2 08.08"
            />
          </div>
          <div className="w-48">
            <ObjectTile
              view="large"
              id="SXT-005"
              title="Розовые стринги"
              kind="sexting"
              countLabel="15 фото"
              sign={{ kind: 'trouble', label: 'нельзя на OnlyFans' }}
            />
          </div>
          <div className="w-34">
            <ObjectTile
              view="tile"
              id="FYP-0801"
              title="Зеркало, чёрное боди"
              kind="fyp"
              durationSeconds={9}
            />
          </div>
          <div className="w-34">
            <ObjectTile
              view="tile"
              id="SET-074"
              title="Чтение книги, стринги"
              kind="set"
              countLabel="46 фото"
              selected
            />
          </div>
        </div>
        <div className="flex max-w-4xl flex-col">
          <ObjectTile
            view="row"
            id="PPV-073"
            title="День рождения, торт, кружево"
            kind="ppv"
            coverFamily="party"
            columns={['13:24', '07.08', 'Fansly 1–3, OF VIP']}
          />
          <ObjectTile
            view="row"
            id="PPV-074"
            title="Кристаллы и каблуки"
            kind="ppv"
            sign={{ kind: 'turn', label: 'Hub нашёл похожее' }}
            columns={['9:41', '09.08', 'Fansly 1, 2']}
            selected
          />
          <ObjectTile
            view="row"
            id="PPV-076"
            title="Нейлон и каблуки"
            kind="ppv"
            columns={['8:12', '19.09', 'ещё нигде']}
          />
        </div>
      </GallerySection>
      <GallerySection title="Мозаики" note="feature · columns · grid-6 · grid-4">
        <div className="grid grid-cols-4 gap-4">
          {libraryFolders
            .slice(0, 6)
            .filter((folder, index) => index !== 4 && folder.layout !== undefined)
            .map((folder) => (
              <Specimen key={folder.href} label={folder.layout ?? 'feature'}>
                <Mosaic tiles={folder.tiles} layout={folder.layout} className="w-full rounded-lg" />
              </Specimen>
            ))}
        </div>
      </GallerySection>
      <GallerySection title="Папка" note="наведение — подложка">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {libraryFolders.slice(0, 3).map((folder) => (
            <FolderTile key={folder.href} {...folder} />
          ))}
        </div>
      </GallerySection>
    </>
  )
}
