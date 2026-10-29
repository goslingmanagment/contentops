import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronRightIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useMarkupField } from './use-markup-field'

/**
 * «Тексты для платформы (EN)» у PPV — свёрнутый блок, только если тексты есть
 * (DESIGN §4.4, §4.20): подпись для стены и для рассылки, у каждой «Копировать».
 */
export function PlatformTexts() {
  const field = useMarkupField('platform_texts')
  const toast = useActionToast()
  const [open, setOpen] = useState(false)
  const texts = field?.field.key === 'platform_texts' ? field.field.value : null
  if (!texts) {
    return null
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.show({ message: 'Текст скопирован' })
    } catch (error) {
      toast.showFailure(error, { failed: 'Не скопировалось' })
    }
  }
  const rows = [
    { label: 'Стена', text: texts.wall },
    { label: 'Рассылка', text: texts.message },
  ]
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1 self-start text-ink-3 text-sm transition-colors duration-120 hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn('size-4 text-ink-3 transition-transform duration-120', open && 'rotate-90')}
        />
        Тексты для платформы (EN)
      </button>
      {open
        ? rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-1 pl-5">
              <div className="flex items-center justify-between">
                <span className="text-ink-3 text-sm">{row.label}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Копировать: ${row.label}`}
                  onClick={() => void copy(row.text)}
                >
                  <CopyIcon />
                </Button>
              </div>
              <p lang="en" className="text-sm">
                {row.text}
              </p>
            </div>
          ))
        : null}
    </div>
  )
}
