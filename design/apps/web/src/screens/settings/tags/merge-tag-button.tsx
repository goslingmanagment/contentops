import { formatNumber, plural, type Tag } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@contentops/ui/components/command'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

function objectsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['объект', 'объекта', 'объектов'])}`
}

/**
 * «Слить с…»: всплывашка со словарём. До нажатия видно, что станет: объекты получат
 * выбранный тег, этот исчезнет. Отмены нет (§3.8).
 */
export function MergeTagButton({ tag, dictionary }: { tag: Tag; dictionary: readonly Tag[] }) {
  const api = useApi()
  const toast = useActionToast()
  const [open, setOpen] = useState(false)
  const merge = useIntentMutation<Tag, Tag>({
    failed: 'Теги не слились',
    run: (into, key) =>
      api.settings.mergeTag({
        params: { tag: tag.key },
        body: { into: into.key },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.tags()],
    onSuccess: (merged) => {
      setOpen(false)
      toast.show({ message: `Слито в «${merged.ru ?? merged.key}» · ${objectsWord(merged.uses)}` })
    },
  })
  const others = dictionary.filter((candidate) => candidate.key !== tag.key)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Слить с…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <p className="px-4 pt-3 pb-2 text-muted-foreground text-sm">
          {objectsWord(tag.uses)} получат выбранный тег, «{tag.ru ?? tag.key}» исчезнет
        </p>
        <Command>
          <CommandInput placeholder="Найти тег" />
          <CommandList>
            <CommandEmpty>Ничего не нашлось</CommandEmpty>
            <CommandGroup>
              {others.map((candidate) => (
                <CommandItem
                  key={candidate.key}
                  value={`${candidate.ru ?? ''} ${candidate.key}`}
                  disabled={merge.isPending}
                  onSelect={() => merge.start(candidate)}
                >
                  <span className="flex-1 truncate">{candidate.ru ?? candidate.key}</span>
                  <span className="font-mono text-ink-3 text-xs">{candidate.key}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
