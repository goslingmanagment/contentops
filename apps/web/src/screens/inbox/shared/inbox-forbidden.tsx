import { Button } from '@contentops/ui/components/button'
import { useNavigate } from '@tanstack/react-router'
import { LockIcon } from 'lucide-react'
import { FieldMessage } from '@/shell/field/field-message'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * 403 в «Приехало» (DESIGN §3.10): закрыт раздел, а не модель — «Только чтение» видит
 * Библиотеку и План этой модели, туда и ведёт ссылка.
 */
export function InboxForbidden() {
  const model = useCurrentModel().code
  const navigate = useNavigate()
  return (
    <FieldMessage>
      <LockIcon aria-hidden className="size-6 text-ink-3" />
      <p className="text-lg">
        Нет доступа к этому разделу
        {' · '}
        <Button
          variant="link"
          size="inline"
          className="text-lg"
          onClick={() => void navigate({ to: '/$model/library', params: { model } })}
        >
          Открыть Библиотеку
        </Button>
      </p>
    </FieldMessage>
  )
}
