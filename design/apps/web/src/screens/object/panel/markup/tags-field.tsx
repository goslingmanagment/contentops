import { TagInput } from '@contentops/ui/components/tag-input'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTags } from '@/data/catalog'
import { TAG_GROUP_OPTIONS, tagLabel, tagOptionsOf } from '@/objects/tag-options'
import { useObjectPage } from '../../object-context'
import { FieldRow } from './field-row'
import { useFieldSave } from './use-field-save'
import { useMarkupField } from './use-markup-field'

/** Пауза после последней правки, прежде чем теги уйдут на сервер. */
const SAVE_DELAY_MS = 800

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

/**
 * «Теги» одной строкой ввода с подсказками (DESIGN §4.4): «по группам» раскрывает
 * действия, атрибуты и настроение. Правки копятся и уходят одним сохранением через
 * секунду тишины — так быстрый набор не спорит сам с собой за версию поля. Черновик,
 * который сервер не принял, сам второй раз не уходит: повтор — из полоски или новой правкой.
 */
export function TagsField() {
  const { canAct } = useObjectPage()
  const field = useMarkupField('tags')
  const save = useFieldSave('tags')
  const tags = useTags().data
  const options = useMemo(() => tagOptionsOf(tags), [tags])
  const saved = useMemo(() => (field?.field.key === 'tags' ? field.field.value : []), [field])
  // `null` — черновика нет, поле показывает то, что на сервере.
  const [draft, setDraft] = useState<readonly string[] | null>(null)
  const attempted = useRef<readonly string[] | null>(null)

  // Сервер догнал черновик (своё сохранение) — черновик больше не нужен.
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    if (draft && sameTags(draft, saved)) {
      setDraft(null)
    }
  }

  const { save: commit, pending, conflict } = save
  useEffect(() => {
    if (!draft || pending || conflict || draft === attempted.current || sameTags(draft, saved)) {
      return
    }
    const timer = window.setTimeout(() => {
      attempted.current = draft
      commit({ key: 'tags', value: [...draft] })
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [commit, conflict, draft, pending, saved])

  return (
    <FieldRow
      label="Теги"
      field={field}
      conflict={save.conflict}
      onShowTheirs={() => {
        setDraft(null)
        save.showTheirs()
      }}
      onKeepMine={() => void save.keepMine()}
    >
      {() =>
        canAct ? (
          <TagInput
            label="Теги"
            value={draft ?? saved}
            onChange={setDraft}
            options={options}
            groups={TAG_GROUP_OPTIONS}
          />
        ) : (
          <p className={saved.length === 0 ? 'text-ink-3' : undefined}>
            {saved.length === 0
              ? 'не заполнено'
              : saved.map((tag) => tagLabel(tags, tag)).join(', ')}
          </p>
        )
      }
    </FieldRow>
  )
}
