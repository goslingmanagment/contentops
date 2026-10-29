import { CalendarPlusIcon, CheckIcon, DownloadIcon, UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '../../src/components/badge'
import { Button } from '../../src/components/button'
import { Checkbox } from '../../src/components/checkbox'
import { ChoiceChips } from '../../src/components/choice-chips'
import { DarkSurface } from '../../src/components/dark-surface'
import {
  FilterChipsRow,
  FilterSelectChip,
  FilterToggleChip,
} from '../../src/components/filter-chips'
import { Input } from '../../src/components/input'
import { IntegrationLine } from '../../src/components/integration-line'
import { Kbd, KbdGroup } from '../../src/components/kbd'
import { Label } from '../../src/components/label'
import { RadioGroup, RadioGroupItem } from '../../src/components/radio-group'
import { SectionTabs } from '../../src/components/section-tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../src/components/select'
import { Switch } from '../../src/components/switch'
import { Tabs, TabsList, TabsTrigger } from '../../src/components/tabs'
import { Textarea } from '../../src/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '../../src/components/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../src/components/tooltip'
import { GallerySection, Specimen } from '../gallery-section'

const buttonVariants = ['default', 'secondary', 'outline', 'ghost', 'link', 'destructive'] as const

export function ControlsPage() {
  const [pressed, setPressed] = useState(true)
  return (
    <>
      <GallerySection
        title="Кнопки"
        note="36 / 30 / 44; синяя одна на экран, в строках — белые с контуром"
      >
        {buttonVariants.map((variant) => (
          <Specimen key={variant} label={variant}>
            <Button variant={variant}>
              <CalendarPlusIcon />В план
            </Button>
            <Button variant={variant} size="sm">
              Отметить
            </Button>
            <Button variant={variant} pending>
              Принять
            </Button>
            <Button variant={variant} disabled>
              Принять
            </Button>
          </Specimen>
        ))}
        <Specimen label="значки 36 / 30 / 44 и «Загрузить»">
          <Button variant="ghost" size="icon" aria-label="Скачать">
            <DownloadIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Скачать">
            <DownloadIcon />
          </Button>
          <Button variant="secondary" size="icon-lg" aria-label="Скачать">
            <DownloadIcon />
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-54 border-transparent shadow-xs [&_svg]:text-primary"
          >
            <UploadIcon />
            Загрузить
          </Button>
        </Specimen>
        <Specimen label="в тёмной полосе: первая белая, остальные прозрачные">
          <DarkSurface className="flex h-14 items-center gap-1 rounded-2xl bg-bar px-2">
            <Button>В план</Button>
            <Button variant="bar">
              <DownloadIcon />
              Скачать
            </Button>
            <Button variant="bar">В промо</Button>
            <Button variant="bar" pending>
              Отметить
            </Button>
          </DarkSurface>
        </Specimen>
      </GallerySection>

      <GallerySection title="Чипы и переключатели" note="чип 32, радиус 16; ряд чипов стоит всегда">
        <FilterChipsRow
          canReset
          onReset={() => undefined}
          trailing={
            <IntegrationLine state="down">Hub недоступен для OF Free с 13:52</IntegrationLine>
          }
        >
          <FilterSelectChip
            label="Где залито"
            options={[{ value: 'lora-2:no', label: 'Fansly 2 · нет' }]}
            selected={['lora-2:no']}
            onSelectedChange={() => undefined}
          />
          <FilterSelectChip
            label="Теги"
            options={[]}
            selected={[]}
            onSelectedChange={() => undefined}
          />
          <FilterToggleChip label="Без тизера" pressed={pressed} onPressedChange={setPressed} />
          <FilterToggleChip label="Без фото" pressed={false} />
        </FilterChipsRow>
        <Specimen label="вид и вкладки">
          <ToggleGroup type="single" variant="segment" defaultValue="large" aria-label="Вид">
            <ToggleGroupItem value="large" aria-label="Крупная плитка">
              <CheckIcon />
            </ToggleGroupItem>
            <ToggleGroupItem value="tile">Плитка</ToggleGroupItem>
            <ToggleGroupItem value="row">Список</ToggleGroupItem>
          </ToggleGroup>
          <Tabs defaultValue="details">
            <TabsList>
              <TabsTrigger value="details">Сведения</TabsTrigger>
              <TabsTrigger value="history">История</TabsTrigger>
            </TabsList>
          </Tabs>
          <SectionTabs
            label="Страницы"
            value="lora-2"
            onChange={() => {}}
            tabs={[
              { value: 'lora-1', label: 'Fansly 1', detail: 26 },
              { value: 'lora-2', label: 'Fansly 2', detail: 30 },
              { value: 'lora-vip-of', label: 'OF VIP', detail: 58 },
            ]}
          />
        </Specimen>
        <Specimen label="выбор значения: ChoiceChips">
          <ChoiceChips
            label="Имя фана в ролике"
            value="no"
            onChange={() => {}}
            choices={[
              { value: 'yes', label: 'есть' },
              { value: 'no', label: 'нет' },
              { value: 'unknown', label: 'не знаю' },
            ]}
          />
          <ChoiceChips<string>
            multiple
            label="Страницы"
            value={['lora-1', 'lora-2']}
            onChange={() => {}}
            choices={[
              { value: 'lora-1', label: 'Fansly 1' },
              { value: 'lora-2', label: 'Fansly 2' },
              {
                value: 'lora-vip-of',
                label: 'OF VIP',
                disabledReason: 'нельзя: второй человек в кадре',
              },
            ]}
          />
        </Specimen>
        <Specimen label="метки и клавиши">
          <Badge>мастер</Badge>
          <Badge variant="outline">обр.</Badge>
          <Badge variant="tint">ИИ</Badge>
          <Badge variant="attention">слишком рано</Badge>
          <Badge variant="destructive">≠ 0:09 и 0:11</Badge>
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          <Kbd>/</Kbd>
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">
                С подсказкой
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Имя с кодом страницы <Kbd>↓</Kbd>
            </TooltipContent>
          </Tooltip>
        </Specimen>
      </GallerySection>

      <GallerySection title="Поля ввода" note="рамка --input, фокус синий">
        <div className="grid max-w-3xl grid-cols-2 gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="title">Название</Label>
            <Input id="title" defaultValue="День рождения, торт, кружево" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="empty">Имя фана в ролике</Label>
            <Input id="empty" placeholder="не заполнено" />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Канал</Label>
            <Select defaultValue="instagram">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="reddit">Reddit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="note">Заметка</Label>
            <Textarea id="note" defaultValue="Без музыки, только звук комнаты" />
          </div>
          <div className="col-span-2 flex items-center gap-6 whitespace-nowrap">
            <Label className="gap-2.5">
              <Checkbox defaultChecked /> Стереть метаданные
            </Label>
            <Label className="gap-2.5">
              <Checkbox /> Залить заново
            </Label>
            <Label className="gap-2.5">
              <Switch defaultChecked /> Второй человек в кадре
            </Label>
          </div>
          <RadioGroup className="col-span-2 flex gap-5">
            <Label className="gap-2.5">
              <RadioGroupItem value="bundle" /> бандл
            </Label>
            <Label className="gap-2.5">
              <RadioGroupItem value="dm" /> в личку
            </Label>
          </RadioGroup>
        </div>
      </GallerySection>
    </>
  )
}
