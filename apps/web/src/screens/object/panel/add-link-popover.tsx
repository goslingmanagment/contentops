import type { ItemId, NewProvenanceLink } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { PlusIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCatalogIndex } from '@/data/catalog'
import { ItemPicker } from '@/objects/dialogs/item-picker'
import { useObjectPage } from '../object-context'
import { linkKindsFor } from './provenance-links'

/** «+ Связь…» (DESIGN §4.4): вид связи чипами и поиск объекта по индексу, без запроса. */
export function AddLinkPopover({ onAdd }: { onAdd: (link: NewProvenanceLink) => void }) {
  const { detail, model } = useObjectPage()
  const index = useCatalogIndex(model.code)
  const kinds = linkKindsFor(detail.entry.type)
  const [open, setOpen] = useState(false)
  const [kindId, setKindId] = useState<string | null>(null)
  const [target, setTarget] = useState<ItemId | null>(null)
  const entries = useMemo(
    () => (index.data?.items ?? []).filter((entry) => entry.id !== detail.entry.id),
    [detail.entry.id, index.data],
  )
  const kind = kinds.find((candidate) => candidate.id === kindId)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setKindId(null)
          setTarget(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="link" size="inline" className="text-sm">
          <PlusIcon className="size-3.5" />
          Связь…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-96 flex-col gap-4">
        <ChoiceChips
          label="Вид связи"
          choices={kinds.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
          value={kindId}
          onChange={setKindId}
        />
        <ItemPicker label="Найти объект" entries={entries} value={target} onChange={setTarget} />
        <Button
          className="self-start"
          disabled={!kind || !target}
          onClick={() => {
            if (kind && target) {
              onAdd({ relation: kind.relation, direction: kind.direction, item_id: target })
              setOpen(false)
            }
          }}
        >
          Связать
        </Button>
      </PopoverContent>
    </Popover>
  )
}
