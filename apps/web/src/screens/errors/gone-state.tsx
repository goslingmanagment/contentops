import { Button } from '@contentops/ui/components/button'
import { GitMergeIcon, Trash2Icon } from 'lucide-react'
import { FieldMessage } from '@/shell/field/field-message'

interface GoneStateProps {
  /** Удалён или слит: значок над фразой. */
  kind?: 'deleted' | 'merged'
  /** «PPV-032 слит с PPV-031» или «Удалён 12.09 Дианой». */
  message: string
  /** «Открыть PPV-031» или «Журнал». */
  action: { label: string; onSelect: () => void }
}

/** Удалён или слит (DESIGN §3.10): что стало и куда идти дальше. */
export function GoneState({ kind = 'deleted', message, action }: GoneStateProps) {
  const Icon = kind === 'merged' ? GitMergeIcon : Trash2Icon
  return (
    <FieldMessage>
      <Icon aria-hidden className="size-6 text-ink-3" />
      <p className="text-lg">
        {message}
        {' · '}
        <Button variant="link" size="inline" className="text-lg" onClick={action.onSelect}>
          {action.label}
        </Button>
      </p>
    </FieldMessage>
  )
}
