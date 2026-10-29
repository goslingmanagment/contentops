import { CircleHelpIcon } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { modifierKeyLabel } from '../lib/platform'
import { Button } from './button'
import { Kbd, KbdGroup } from './kbd'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './popover'

export interface Hotkey {
  keys: readonly (readonly string[])[]
  description: string
}

/** Набор клавиш DESIGN §3.12; `mod` подписывается по системе (Ctrl или ⌘). */
export const defaultHotkeys: readonly Hotkey[] = [
  { keys: [['/'], ['mod', 'K']], description: 'поиск' },
  { keys: [['←', '→', '↑', '↓']], description: 'перемещение по плиткам и строкам' },
  { keys: [['Enter']], description: 'открыть' },
  { keys: [['Space']], description: 'просмотр; в просмотре — пауза' },
  { keys: [['i']], description: 'панель сведений' },
  { keys: [['mod', 'A']], description: 'выделить всё, что прошло фильтры' },
  { keys: [['Esc']], description: 'снять выделение, закрыть окно или просмотр' },
  { keys: [['mod', 'Z']], description: 'отменить последнее действие, пока видна полоска' },
  {
    keys: [['1'], ['2'], ['3']],
    description: 'в очередях решений: 1 — главное «да», 2 — второй вариант, 3 — отказ',
  },
  { keys: [['?']], description: 'список клавиш' },
]

interface HotkeysHelpProps {
  hotkeys?: readonly Hotkey[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Своя кнопка; по умолчанию — значок `?` 36. */
  trigger?: ReactNode
}

/** Список клавиш во всплывашке 480 (§3.12). */
export function HotkeysHelp({
  hotkeys = defaultHotkeys,
  open,
  onOpenChange,
  trigger,
}: HotkeysHelpProps) {
  const mod = modifierKeyLabel()
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="icon" aria-label="Клавиши">
            <CircleHelpIcon />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-120 gap-4 p-5">
        <PopoverTitle>Клавиши</PopoverTitle>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-2.5">
          {hotkeys.map((hotkey) => (
            <Fragment key={hotkey.description}>
              <dt className="flex items-center gap-2">
                {hotkey.keys.map((combo) => (
                  <KbdGroup key={combo.join('+')}>
                    {combo.map((key) => (
                      <Kbd key={key}>{key === 'mod' ? mod : key}</Kbd>
                    ))}
                  </KbdGroup>
                ))}
              </dt>
              <dd className="text-muted-foreground">{hotkey.description}</dd>
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}
