import { IntegrationLine } from '../../src/components/integration-line'
import { PlacementLine } from '../../src/components/placement-line'
import { ProgressWord } from '../../src/components/progress-word'
import {
  FolderTileSkeleton,
  ListRowSkeleton,
  ObjectTileSkeleton,
} from '../../src/components/skeletons'
import { ConflictLine, EmptyState, ErrorLine } from '../../src/components/state-lines'
import { StatusSign } from '../../src/components/status-sign'
import { StatusWord } from '../../src/components/status-word'
import { WhyPopover } from '../../src/components/why-popover'
import { GallerySection, Specimen } from '../gallery-section'
import { ppv073Placement } from './sample-menus'

const noop = () => undefined

export function StatusPage() {
  return (
    <>
      <GallerySection title="Язык состояний" note="DESIGN §5: три знака, остальное серым словом">
        <Specimen label="знаки 14 и 12 — форма читается без цвета">
          <StatusSign kind="done" />
          <StatusSign kind="turn" />
          <StatusSign kind="trouble" />
          <StatusSign kind="done" size={12} />
          <StatusSign kind="turn" size={12} />
          <StatusSign kind="trouble" size={12} />
          <StatusSign kind="done" className="grayscale" />
        </Specimen>
        <Specimen label="слова">
          <StatusWord sign="done" detail="Hub, по имени файла">
            подтверждено
          </StatusWord>
          <StatusWord sign="turn" detail="совпало 22 из 23">
            сверить
          </StatusWord>
          <StatusWord sign="trouble">пропущено</StatusWord>
          <StatusWord>в плане</StatusWord>
          <StatusWord>отмечено</StatusWord>
          <StatusWord>в планировщике</StatusWord>
          <StatusWord>не видели</StatusWord>
          <StatusWord size="xs" sign="done">
            07.08
          </StatusWord>
        </Specimen>
        <Specimen label="долгие операции">
          <ProgressWord label="сжимается" value={62} className="w-40" />
          <ProgressWord label="" value={55} text="качается 3,2 из 5,8 ГБ" className="w-48" />
          <ProgressWord label="готовится" value={40} className="w-32" />
        </Specimen>
        <Specimen label="«почему» по нажатию (открыто)" className="min-h-64">
          <WhyPopover
            open
            hint="Hub нашёл похожее"
            tone="turn"
            title={
              <StatusWord sign="turn" detail="Hub нашёл похожее">
                сверить
              </StatusWord>
            }
            facts={[
              'В плане на 03:00 · поставила Диана 19.09',
              'Отметки нет',
              'Hub — пост 03:06, +6 мин · 0:09 = 0:09',
            ]}
            action={{ label: 'Сверить', onSelect: noop }}
          >
            <StatusWord sign="turn" detail="Hub нашёл похожее">
              сверить
            </StatusWord>
          </WhyPopover>
        </Specimen>
      </GallerySection>

      <GallerySection
        title="Интеграции"
        note="DESIGN §3.11: пять состояний, кнопка только владельцу"
      >
        <div className="flex flex-col items-start gap-3">
          <IntegrationLine state="ok">Hub · 38 мин назад</IntegrationLine>
          <IntegrationLine state="off" action={{ label: 'Включить', onSelect: noop }}>
            Hub выключен для Fansly 3 — отметки работают
          </IntegrationLine>
          <IntegrationLine state="unset" action={{ label: 'Настроить', onSelect: noop }}>
            Hub для Fansly 2 Ари не настроен
          </IntegrationLine>
          <IntegrationLine state="down" action={{ label: 'Подробнее', onSelect: noop }}>
            Hub недоступен для OF Free с 13:52 · повтор через 8 мин
          </IntegrationLine>
          <IntegrationLine state="catching-up">
            Hub догоняет пропущенное · 3 из 12 ч
          </IntegrationLine>
        </div>
        <Specimen label="где залито">
          <PlacementLine entries={ppv073Placement} activePage="Fansly 3" />
        </Specimen>
      </GallerySection>

      <GallerySection title="Пусто, ошибка, конфликт" note="DESIGN §3.10">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-border border-dashed">
            <EmptyState action={{ label: 'Сбросить', onSelect: noop }}>
              По этим фильтрам ничего
            </EmptyState>
          </div>
          <div className="rounded-xl border border-border border-dashed">
            <ErrorLine layout="center" message="Не загрузилось" onRetry={noop} />
          </div>
        </div>
        <ErrorLine message="Не удалось обновить — показано на 16:02" onRetry={noop} />
        <ConflictLine
          message="Диана изменила название 1 мин назад"
          onShowTheirs={noop}
          onKeepMine={noop}
        />
      </GallerySection>

      <GallerySection title="Заготовки загрузки" note="ровно размера плиток и строк">
        <div className="grid grid-cols-[repeat(4,200px)_repeat(2,176px)_120px] items-start gap-4">
          <FolderTileSkeleton />
          <FolderTileSkeleton />
          <FolderTileSkeleton />
          <FolderTileSkeleton />
          <ObjectTileSkeleton view="large" />
          <ObjectTileSkeleton view="large" />
          <ObjectTileSkeleton view="tile" />
        </div>
        <div className="flex max-w-3xl flex-col">
          <ObjectTileSkeleton view="row" />
          <ListRowSkeleton height={54} />
          <ListRowSkeleton height={64} />
        </div>
      </GallerySection>
    </>
  )
}
