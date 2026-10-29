import { cn } from 'cn'
import { ChevronDownIcon, DownloadIcon } from 'lucide-react'
import { useState } from 'react'
import { Button, type ButtonProps } from './button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

export interface DownloadOption {
  id: string
  /** «Для заливки», «Мастер (для монтажа)». */
  label: string
  /** Подпись серым: «копия для платформы · готова, 18 МБ». */
  hint?: string
  /** Будущее имя файла — в подсказке при наведении. */
  fileName?: string
  disabled?: boolean
}

interface DownloadButtonProps {
  /** Варианты по порядку; нажатие на «Скачать» отдаёт первый. */
  options: readonly DownloadOption[]
  onDownload: (optionId: string, stripMetadata: boolean) => void
  label?: string
  variant?: Extract<ButtonProps['variant'], 'default' | 'secondary' | 'outline' | 'bar'>
  size?: 'default' | 'sm'
  /** Управление меню снаружи (открыть по клавише, показать в галерее). */
  menuOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
  className?: string
}

/**
 * «Скачать ▾» (DESIGN §4.4): кнопка из двух частей. Основная часть сразу отдаёт первый
 * вариант со стёртыми метаданными; стрелка открывает меню 320 с галочкой «Стереть
 * метаданные», которая включается заново при каждом открытии.
 */
export function DownloadButton({
  options,
  onDownload,
  label = 'Скачать',
  variant = 'secondary',
  size = 'default',
  menuOpen,
  onMenuOpenChange,
  className,
}: DownloadButtonProps) {
  const [stripMetadata, setStripMetadata] = useState(true)
  const primary = options.find((option) => !option.disabled)

  return (
    <div data-slot="download-button" className={cn('inline-flex', className)}>
      <Button
        variant={variant}
        size={size}
        disabled={!primary}
        onClick={() => primary && onDownload(primary.id, true)}
        className="rounded-r-none"
      >
        <DownloadIcon />
        {label}
      </Button>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) {
            setStripMetadata(true)
          }
          onMenuOpenChange?.(open)
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size={size === 'sm' ? 'icon-sm' : 'icon'}
            aria-label="Другие варианты скачивания"
            className={cn(
              'w-8 rounded-l-none border-l',
              variant === 'default' ? 'border-l-primary-foreground/30' : 'border-l-line-strong',
            )}
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {options.map((option) => (
            <DownloadItem
              key={option.id}
              option={option}
              onSelect={() => onDownload(option.id, stripMetadata)}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={stripMetadata}
            onCheckedChange={(checked) => setStripMetadata(checked)}
            onSelect={(event) => event.preventDefault()}
          >
            Стереть метаданные
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function DownloadItem({ option, onSelect }: { option: DownloadOption; onSelect: () => void }) {
  const item = (
    <DropdownMenuItem disabled={option.disabled} onSelect={onSelect}>
      <span className="flex min-w-0 flex-col">
        <span>{option.label}</span>
        {option.hint ? <span className="truncate text-ink-3 text-sm">{option.hint}</span> : null}
      </span>
    </DropdownMenuItem>
  )
  if (!option.fileName) {
    return item
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-md font-mono text-xs">
        {option.fileName}
      </TooltipContent>
    </Tooltip>
  )
}
