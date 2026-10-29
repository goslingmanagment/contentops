import {
  formatNumber,
  plural,
  TAG_GROUP_LABEL,
  type Tag,
  TagGroupSchema,
  type UpdateTagCommand,
} from '@contentops/contracts'
import { Input } from '@contentops/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { type FormEvent, useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { MergeTagButton } from './merge-tag-button'

const FREE = 'free'
const INVALIDATES = [queryKeys.tags()]

function usesWord(uses: number): string {
  return `${formatNumber(uses)} ${plural(uses, ['объект', 'объекта', 'объектов'])}`
}

interface TagRowProps {
  tag: Tag
  dictionary: readonly Tag[]
}

/**
 * Тег словаря: русское имя (правится на месте, сохраняется по Enter и при уходе из поля) и
 * число объектов слева; справа ключ мелко серым, группа и «Слить с…».
 */
export function TagRow({ tag, dictionary }: TagRowProps) {
  const api = useApi()
  const toast = useActionToast()
  const ruId = useId()
  const groupLabelId = useId()
  const [ru, setRu] = useState(tag.ru ?? '')
  const save = useVersionedSave<UpdateTagCommand, Tag>({
    subject: 'тег',
    failed: 'Тег не сохранился',
    invalidates: INVALIDATES,
    run: (body, version, key) =>
      api.settings.updateTag({
        params: { tag: tag.key },
        body,
        ifMatch: version,
        idempotencyKey: key,
      }),
    onSuccess: (saved) => toast.show({ message: `Сохранено · ${saved.ru ?? saved.key}` }),
  })

  const saveRu = (event?: FormEvent) => {
    event?.preventDefault()
    const next = ru.trim() || null
    if (next !== tag.ru && !save.isPending) {
      save.save({ ru: next }, tag.version)
    }
  }
  const saveGroup = (value: string) => {
    const group = value === FREE ? null : TagGroupSchema.parse(value)
    if (group !== tag.group) {
      save.save({ group }, tag.version)
    }
  }

  return (
    <div data-slot="settings-row" className="flex flex-col">
      <div className="flex min-h-14 items-center gap-6 py-1.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <form onSubmit={saveRu}>
            <label htmlFor={ruId} className="sr-only">
              Русское имя тега {tag.key}
            </label>
            <Input
              id={ruId}
              value={ru}
              placeholder="русское имя"
              disabled={save.isPending}
              onChange={(event) => setRu(event.target.value)}
              onBlur={() => saveRu()}
              className="-ml-2.75 h-8 w-64 max-w-full border-transparent px-2.5 hover:border-input"
            />
          </form>
          <p className="text-muted-foreground text-sm tabular-nums">{usesWord(tag.uses)}</p>
        </div>
        <span className="font-mono text-ink-3 text-xs">{tag.key}</span>
        <span id={groupLabelId} className="sr-only">
          Группа тега {tag.key}
        </span>
        <Select value={tag.group ?? FREE} onValueChange={saveGroup} disabled={save.isPending}>
          <SelectTrigger
            aria-labelledby={groupLabelId}
            className="w-40 border-transparent hover:border-input data-[state=open]:border-input"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TagGroupSchema.options.map((group) => (
              <SelectItem key={group} value={group}>
                {TAG_GROUP_LABEL[group]}
              </SelectItem>
            ))}
            <SelectItem value={FREE}>без группы</SelectItem>
          </SelectContent>
        </Select>
        <MergeTagButton tag={tag} dictionary={dictionary} />
      </div>
      {save.conflict ? (
        <ConflictLine
          message={save.conflict.message}
          theirsLabel={save.conflict.theirsLabel}
          onShowTheirs={save.showTheirs}
          onKeepMine={() => save.keepMine()}
          className="mb-3"
        />
      ) : null}
    </div>
  )
}
