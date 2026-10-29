import { Button } from '../../src/components/button'
import {
  EventDayHeader,
  EventDetails,
  EventRow,
  EventRowSkeleton,
} from '../../src/components/event-row'
import { FormField } from '../../src/components/form-field'
import { Input } from '../../src/components/input'
import { IntegrationLine } from '../../src/components/integration-line'
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionSkeleton,
} from '../../src/components/settings-section'
import { ConflictLine } from '../../src/components/state-lines'
import { Switch } from '../../src/components/switch'
import { Thumb } from '../../src/components/thumb'
import { GallerySection } from '../gallery-section'

const noop = () => undefined

/** Журнал и настройки: строка события 48, раскрытие, раздел формы, поле окна. */
export function RecordsPage() {
  return (
    <>
      <GallerySection
        title="Строка журнала"
        note="48; автор значком, объект ссылкой, отказ красным"
      >
        <div className="flex flex-col">
          <EventDayHeader>Сегодня, 22 сентября</EventDayHeader>
          <EventRow
            time="13:10"
            actor="person"
            expanded={false}
            thumb={
              <Thumb
                seed="PPV-076"
                kind="ppv"
                aspect="1:1"
                showCaptions={false}
                className="w-8 rounded-md"
              />
            }
          >
            Диана загрузила тизер для <span className="text-primary-ink">PPV-076</span>
          </EventRow>
          <EventRow time="13:52" actor="system" expanded>
            Система: Hub недоступен для OF Free
          </EventRow>
          <EventDetails
            changes={[{ field: 'Hub · OF Free', before: 'работает', after: 'недоступен' }]}
            meta="22.09.2026, 13:52 · Система"
          />
          <EventRow time="18:40" actor="agent" selected expanded={false}>
            Агент импорта: <span className="text-destructive">отказ</span> — нет прав на модель Ари
          </EventRow>
          <EventRowSkeleton />
        </div>
      </GallerySection>
      <GallerySection title="Раздел настроек" note="строки от 56 через линию, управление справа">
        <SettingsSection
          title="Agency Hub · Лора"
          aside={<span className="w-32 text-center text-ink-3 text-sm">Автосверка</span>}
        >
          <SettingsRow
            label="Fansly 3"
            detail={<IntegrationLine state="ok">работает · 38 мин назад</IntegrationLine>}
          >
            <span className="flex w-32 justify-center">
              <Switch aria-label="Автосверка Hub · Fansly 3" defaultChecked />
            </span>
          </SettingsRow>
          <SettingsRow
            label="OF Free"
            detail={
              <IntegrationLine state="down">
                Hub недоступен для OF Free с 13:52 · повтор через 8 мин
              </IntegrationLine>
            }
            below={
              <ConflictLine
                message="Дмитрий изменил порог 1 мин назад"
                theirsLabel="Показать его вариант"
                onShowTheirs={noop}
                onKeepMine={noop}
                className="mb-3"
              />
            }
          >
            <Button variant="outline" size="sm">
              Настроить
            </Button>
          </SettingsRow>
        </SettingsSection>
        <SettingsSectionSkeleton rows={2} />
      </GallerySection>
      <GallerySection title="Поле окна" note="подпись 13 серым, место под ошибку держится">
        <div className="grid max-w-120 grid-cols-2 gap-x-3">
          <FormField htmlFor="gallery-login" label="Логин" hint="Латиница, цифры, точка">
            <Input id="gallery-login" defaultValue="katya" />
          </FormField>
          <FormField htmlFor="gallery-name" label="Имя" error="Нужно имя">
            <Input id="gallery-name" aria-invalid />
          </FormField>
        </div>
      </GallerySection>
    </>
  )
}
