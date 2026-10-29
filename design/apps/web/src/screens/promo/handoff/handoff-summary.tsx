import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { CopyIcon } from 'lucide-react'
import { useActionToast } from '@/actions/action-toast-context'

/**
 * Сводка для Telegram (DESIGN §4.17): «КП2 офис нейлон · 60 видео · 2,65 ГБ» и
 * «Копировать сводку» — текст уходит подрядчику вместе с ZIP.
 */
export function HandoffSummary({ text }: { text: string }) {
  const toast = useActionToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.show({ message: 'Сводка скопирована' })
    } catch {
      // Буфер обмена не дали (права браузера) — это не ошибка сети.
      toast.show({ message: 'Не скопировалось', tone: 'error' })
    }
  }
  return (
    <InfoSection title="Сводка для Telegram">
      <p className="rounded-xl bg-muted px-3.5 py-3 text-base">{text}</p>
      <Button variant="outline" size="sm" className="self-start" onClick={() => void copy()}>
        <CopyIcon />
        Копировать сводку
      </Button>
    </InfoSection>
  )
}
