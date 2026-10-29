import { Button } from '@contentops/ui/components/button'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'

interface SecretOnceProps {
  /** Токен агента или временный пароль. */
  secret: string
  /** Что это: «Токен», «Временный пароль». */
  label: string
}

/**
 * Секрет, который показывается один раз (DESIGN §4.19): моноширинно, с «Копировать».
 * Закрыли окно — больше его не увидеть, ни здесь, ни в журнале.
 */
export function SecretOnce({ secret, label }: SecretOnceProps) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(secret)
    setCopied(true)
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ink-3 text-sm">{label}</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-foreground text-xs">{secret}</code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Скопировано' : 'Копировать'}
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        Показывается один раз. Закроете окно — не увидите
      </p>
    </div>
  )
}
