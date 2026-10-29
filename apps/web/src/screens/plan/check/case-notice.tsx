import { isApiError } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'

interface CaseNoticeProps {
  /** Ответ на `GET …/reconcile/<id>` для случая из адреса, которого нет в очереди. */
  error: unknown
  onShowDone: () => void
}

/**
 * Случай из адреса уже не ждёт человека (DESIGN §3.10): одна серая строка над очередью —
 * «Случай уже решён · Решённые» или «Такого случая сверки нет».
 */
export function CaseNotice({ error, onShowDone }: CaseNoticeProps) {
  const resolved = isApiError(error) && error.status === 422
  return (
    <p className="flex min-h-9 items-center gap-1 text-base text-muted-foreground">
      {resolved ? 'Случай уже решён' : 'Такого случая сверки нет'}
      {resolved ? (
        <>
          {' · '}
          <Button variant="link" size="inline" onClick={onShowDone}>
            Решённые
          </Button>
        </>
      ) : null}
    </p>
  )
}
