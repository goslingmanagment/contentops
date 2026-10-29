import { CalendarDaysIcon, FolderIcon, HistoryIcon, InboxIcon } from 'lucide-react'
import { useEffect } from 'react'
import { ActionToastBar, ActionToaster, showActionToast } from '../../src/components/action-toast'
import { Button } from '../../src/components/button'
import { DownloadButton } from '../../src/components/download-button'
import { FieldHeader } from '../../src/components/field-header'
import { IntegrationLine } from '../../src/components/integration-line'
import { NavItem } from '../../src/components/nav-item'
import { SelectionBar } from '../../src/components/selection-bar'
import { SpaceCard } from '../../src/components/space-card'
import { UploadTray } from '../../src/components/upload-tray'
import { GallerySection } from '../gallery-section'
import { downloadOptions, objectMenu } from './sample-menus'

const noop = () => undefined

export function BarsPage() {
  useEffect(() => {
    showActionToast({
      message: 'Поставлено · Fansly 2 · ср 23, 03:00',
      action: { label: 'Отменить', onSelect: noop },
      undoable: true,
      durationMs: Number.POSITIVE_INFINITY,
    })
  }, [])
  return (
    <>
      <ActionToaster />
      <GallerySection
        title="Шапка поля и полоса выделения"
        note="полоса встаёт на место шапки той же высоты 72"
      >
        <FieldHeader
          crumbs={[{ label: 'Библиотека', href: '#/' }, { label: 'PPV' }]}
          title="PPV"
          count={90}
          sort={{
            value: 'number',
            options: [{ value: 'number', label: 'По номеру' }],
            onChange: noop,
          }}
          view={{ value: 'large', onChange: noop }}
          info={{ open: false, onToggle: noop }}
          menu={objectMenu}
        />
        <FieldHeader
          title="PPV"
          selectionBar={
            <SelectionBar count={7} onClear={noop} menu={objectMenu}>
              <Button>В план</Button>
              <DownloadButton variant="bar" options={downloadOptions} onDownload={noop} />
              <Button variant="bar">В промо</Button>
            </SelectionBar>
          }
        />
      </GallerySection>

      <GallerySection
        title="Полоски после действия"
        note="тёмные, 44, внизу по центру; одна на экране"
      >
        <div className="flex flex-col items-start gap-3">
          <ActionToastBar
            toastId="a"
            message="Принято → CUS-198 · Открыть"
            action={{ label: 'Отобрать кадры', onSelect: noop }}
          />
          <ActionToastBar
            toastId="b"
            message="Строка отменена"
            reasons={[
              { label: 'не успели', onSelect: noop },
              { label: 'заменили', onSelect: noop },
              { label: 'пауза', onSelect: noop },
            ]}
          />
          <ActionToastBar
            toastId="c"
            tone="error"
            message="Не отметилось: нет связи"
            action={{ label: 'Повторить', onSelect: noop }}
          />
          <ActionToastBar
            toastId="d"
            message="Отмечено 11 из 12 · 1 уже изменили"
            action={{ label: 'Показать', onSelect: noop }}
          />
        </div>
      </GallerySection>

      <GallerySection
        title="Колонка на холсте"
        note="пункт 40, активный — белая подложка; карточка места"
      >
        <div className="flex gap-8 rounded-2xl bg-sidebar p-3">
          <nav className="flex w-60 flex-col gap-1">
            <NavItem href="#/" icon={InboxIcon} label="Приехало" count={9} />
            <NavItem href="#/" icon={FolderIcon} label="Библиотека" active />
            <NavItem href="#/" icon={CalendarDaysIcon} label="План" count={2} countTone="danger" />
            <NavItem href="#/" icon={HistoryIcon} label="Журнал" />
          </nav>
          <nav className="flex w-16 flex-col gap-1">
            <NavItem href="#/" icon={InboxIcon} label="Приехало" count={9} collapsed />
            <NavItem href="#/" icon={FolderIcon} label="Библиотека" active collapsed />
            <NavItem href="#/" icon={CalendarDaysIcon} label="План" count={2} collapsed />
          </nav>
          <div className="flex w-54 flex-col gap-3">
            <SpaceCard href="#/" label="C: свободно 612 ГБ" usedPercent={62} />
            <SpaceCard href="#/" label="Занято 0,52 из 2 ТБ" usedPercent={26}>
              <IntegrationLine state="down" wrap>
                Я.Диск недоступен с 13:40
              </IntegrationLine>
              <IntegrationLine state="catching-up" wrap>
                Hub догоняет пропущенное · 3 из 12 ч
              </IntegrationLine>
            </SpaceCard>
          </div>
        </div>
      </GallerySection>

      <GallerySection title="Лоток загрузок" note="360 × до 240, внизу справа">
        <div className="relative h-72">
          <UploadTray
            className="absolute right-auto bottom-auto left-0 top-0"
            title="Загружается 3 из 5 · 1,2 из 3,4 ГБ"
            collapsed={false}
            onCollapsedChange={noop}
            onCancelAll={noop}
            onResume={noop}
            items={[
              {
                id: '1',
                name: 'FYP-0803_montage.mp4',
                detail: '420 из 800 МБ',
                progress: 52,
                state: 'running',
              },
              {
                id: '2',
                name: 'Копия для платформы · PPV-073',
                detail: '40 %',
                progress: 40,
                state: 'running',
              },
              { id: '3', name: 'IMG_1610.JPG', detail: 'готово', state: 'done' },
              { id: '4', name: 'CUS-195_fix.mov', detail: '', state: 'interrupted' },
            ]}
          />
          <UploadTray
            className="absolute right-auto bottom-auto left-100 top-0"
            title="Загружено 5 из 5"
            collapsed
            onCollapsedChange={noop}
            onClose={noop}
            items={[]}
          />
        </div>
      </GallerySection>
    </>
  )
}
