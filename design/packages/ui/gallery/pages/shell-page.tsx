import { formatDuration } from '@contentops/contracts/format'
import {
  CalendarDaysIcon,
  FolderIcon,
  HistoryIcon,
  InboxIcon,
  SearchIcon,
  UploadIcon,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { Avatar, AvatarFallback } from '../../src/components/avatar'
import { Button } from '../../src/components/button'
import { DownloadButton } from '../../src/components/download-button'
import { FieldHeader } from '../../src/components/field-header'
import {
  FilterChipsRow,
  FilterSelectChip,
  FilterToggleChip,
} from '../../src/components/filter-chips'
import { HotkeysHelp } from '../../src/components/hotkeys-help'
import { InfoPanel, InfoSection } from '../../src/components/info-panel'
import { IntegrationLine } from '../../src/components/integration-line'
import { Kbd } from '../../src/components/kbd'
import { NavItem } from '../../src/components/nav-item'
import { ObjectTile, type ObjectTileView, objectTileHeight } from '../../src/components/object-tile'
import { PlacementLine } from '../../src/components/placement-line'
import { SelectionBar } from '../../src/components/selection-bar'
import { SpaceCard } from '../../src/components/space-card'
import { StatusWord } from '../../src/components/status-word'
import { Thumb } from '../../src/components/thumb'
import { VirtualGrid } from '../../src/components/virtual-grid'
import { VirtualList } from '../../src/components/virtual-list'
import { type SampleObject, samplePpv } from '../sample-objects'
import { downloadOptions, objectMenu, ppv073Placement } from './sample-menus'

const sortOptions = [
  { value: 'number', label: 'По номеру' },
  { value: 'arrived', label: 'По дате прихода' },
  { value: 'stale', label: 'Давно не было на…' },
  { value: 'length', label: 'По длительности' },
]

const tagOptions = ['кружево', 'каблуки', 'бельё', 'чулки', 'зеркало', 'праздник'].map((tag) => ({
  value: tag,
  label: tag,
}))

const getKey = (item: SampleObject) => item.id

/** Корень раздела PPV в оболочке: колонка, верхняя полоса, поле с сеткой и быстрым взглядом. */
export function ShellPage() {
  const [view, setView] = useState<ObjectTileView>('large')
  const [infoOpen, setInfoOpen] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['PPV-073']))
  const [withoutTeaser, setWithoutTeaser] = useState(false)
  const [tags, setTags] = useState<string[]>(['кружево'])
  const [sort, setSort] = useState('number')
  const toggle = useCallback(
    (key: string, checked: boolean) =>
      setSelected((current) => {
        const next = new Set(current)
        if (checked) {
          next.add(key)
        } else {
          next.delete(key)
        }
        return next
      }),
    [],
  )
  const renderTile = (item: SampleObject, state: { selected: boolean }) => (
    <ObjectTile
      view={view}
      id={item.id}
      title={item.title}
      kind="ppv"
      coverFamily={item.id === 'PPV-073' ? 'party' : undefined}
      durationSeconds={item.durationSeconds}
      versionCount={item.versionCount}
      sign={item.sign}
      columns={[formatDuration(item.durationSeconds), item.arrived, item.placement]}
      selected={state.selected}
      onSelectedChange={(checked) => toggle(item.id, checked)}
    />
  )
  const selectionBar =
    selected.size > 1 ? (
      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())} menu={objectMenu}>
        <Button>В план</Button>
        <DownloadButton variant="bar" options={downloadOptions} onDownload={() => undefined} />
        <Button variant="bar">В промо</Button>
      </SelectionBar>
    ) : undefined

  return (
    <div className="grid h-dvh grid-cols-[240px_1fr] grid-rows-[64px_1fr] bg-sidebar max-[1300px]:grid-cols-[224px_1fr]">
      <div className="flex items-center gap-2.5 px-5">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary">
          <span className="size-2.5 rounded-xs border-2 border-primary-foreground" />
        </span>
        <span className="text-md">ContentOps</span>
      </div>
      <div className="flex items-center justify-between pr-3 pl-3">
        <div className="flex h-11 w-140 items-center gap-3 rounded-xl bg-background px-4 text-ink-3">
          <SearchIcon className="size-4.5" />
          <span className="flex-1 truncate text-base">
            Найти: ппв 73, кастом в колготках, фуп у зеркала…
          </span>
          <Kbd>/</Kbd>
        </div>
        <div className="flex items-center gap-2">
          <HotkeysHelp />
          <Avatar>
            <AvatarFallback>Д</AvatarFallback>
          </Avatar>
        </div>
      </div>
      <aside className="flex min-h-0 flex-col gap-1 px-3 pb-3">
        <div className="flex h-14 items-center gap-3 px-2">
          <Avatar className="size-9">
            <AvatarFallback>Л</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-semibold text-base">Лора</span>
            <span className="text-ink-3 text-sm">5 страниц</span>
          </div>
        </div>
        <Button
          variant="outline"
          size="lg"
          className="mb-3 w-full border-transparent shadow-xs [&_svg]:text-primary"
        >
          <UploadIcon />
          Загрузить
        </Button>
        <NavItem href="#/" icon={InboxIcon} label="Приехало" count={9} />
        <NavItem href="#/" icon={FolderIcon} label="Библиотека" active />
        <NavItem href="#/" icon={CalendarDaysIcon} label="План" count={5} countTone="danger" />
        <NavItem href="#/" icon={HistoryIcon} label="Журнал" />
        <SpaceCard href="#/" label="C: свободно 612 ГБ" usedPercent={62} className="mt-auto">
          <IntegrationLine state="down" wrap>
            Hub недоступен для OF Free с 13:52
          </IntegrationLine>
        </SpaceCard>
      </aside>
      <main className="mr-3 mb-3 flex min-h-0 min-w-0 overflow-hidden rounded-3xl bg-background">
        <div className="flex min-w-0 flex-1 flex-col px-7 pt-5">
          <FieldHeader
            crumbs={[{ label: 'Библиотека', href: '#/' }, { label: 'PPV' }]}
            title="PPV"
            count={90}
            sort={{ value: sort, options: sortOptions, onChange: setSort }}
            view={{ value: view, onChange: setView }}
            info={{ open: infoOpen, onToggle: () => setInfoOpen((open) => !open) }}
            menu={{ actions: [{ id: 'deleted', label: 'Удалённые объекты · 3' }] }}
            selectionBar={selectionBar}
          />
          <FilterChipsRow
            canReset={withoutTeaser || tags.length > 0}
            onReset={() => {
              setWithoutTeaser(false)
              setTags([])
            }}
            className="mb-3"
          >
            <FilterSelectChip
              label="Где залито"
              options={[]}
              selected={[]}
              onSelectedChange={() => undefined}
            />
            <FilterSelectChip
              label="Теги"
              options={tagOptions}
              selected={tags}
              onSelectedChange={setTags}
              multiple
            />
            <FilterSelectChip
              label="Разметка"
              options={[]}
              selected={[]}
              onSelectedChange={() => undefined}
            />
            <FilterSelectChip
              label="Дата"
              options={[]}
              selected={[]}
              onSelectedChange={() => undefined}
            />
            <FilterToggleChip label="Второй человек" pressed={false} />
            <FilterSelectChip
              label="Вид"
              options={[]}
              selected={[]}
              onSelectedChange={() => undefined}
            />
            <FilterToggleChip
              label="Без тизера"
              pressed={withoutTeaser}
              onPressedChange={setWithoutTeaser}
            />
            <FilterToggleChip label="Без фото" pressed={false} />
          </FilterChipsRow>
          <div className="-mx-2 min-h-0 flex-1">
            {view === 'row' ? (
              <VirtualList
                items={samplePpv}
                getKey={getKey}
                getItemHeight={() => 52}
                renderItem={renderTile}
                selectedKeys={selected}
                onSelectedKeysChange={setSelected}
                label="PPV"
                className="px-2"
              />
            ) : (
              <VirtualGrid
                items={samplePpv}
                getKey={getKey}
                minColumnWidth={view === 'large' ? 160 : 120}
                getRowHeight={(width) => objectTileHeight(view, width)}
                gap={view === 'large' ? 8 : 4}
                renderItem={renderTile}
                selectedKeys={selected}
                onSelectedKeysChange={setSelected}
                label="PPV"
                className="px-2 pb-6"
              />
            )}
          </div>
        </div>
        {infoOpen ? <QuickLook onClose={() => setInfoOpen(false)} /> : null}
      </main>
    </div>
  )
}

function QuickLook({ onClose }: { onClose: () => void }) {
  return (
    <InfoPanel
      onClose={onClose}
      tabs={[
        {
          value: 'details',
          label: 'Сведения',
          content: (
            <>
              <InfoSection title="PPV-073">
                <div className="flex gap-4">
                  <Thumb
                    seed="PPV-073"
                    family="party"
                    durationSeconds={804}
                    versionCount={2}
                    className="w-33 shrink-0"
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-lg">День рождения, торт, кружево</p>
                    <p className="text-muted-foreground text-sm">
                      Бандл на стену · 13:24 · 21 фото · тизер 0:32 · снято 6 августа
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button>Открыть</Button>
                  <Button variant="secondary">В план</Button>
                  <DownloadButton options={downloadOptions} onDownload={() => undefined} />
                </div>
              </InfoSection>
              <InfoSection title="Где залито">
                <PlacementLine entries={ppv073Placement} activePage="Fansly 3" className="-ml-2" />
              </InfoSection>
              <InfoSection
                title="Разметка"
                aside={<StatusWord sign="done">подтверждена 12.08, Диана</StatusWord>}
              >
                <p className="text-muted-foreground">Теги: кружево, торт, свечи, бельё</p>
              </InfoSection>
            </>
          ),
        },
        {
          value: 'history',
          label: 'История',
          content: <p className="text-muted-foreground">События объекта</p>,
        },
      ]}
    />
  )
}
