import { type ItemFile, mainVideo } from '@contentops/contracts'
import { Textarea } from '@contentops/ui/components/textarea'
import { useState } from 'react'
import { useObjectPage } from '../../object-context'
import { FieldRow } from './field-row'
import { useFieldSave } from './use-field-save'
import { useMarkupField } from './use-markup-field'

/**
 * Подсказка по тому, что в объекте: у ролика — «Что в ролике», у сета — «Что на фото»,
 * у лайфа и секстинга с видео — «Что на фото и в видео».
 */
function descriptionHint(files: readonly ItemFile[]): string {
  if (mainVideo(files)) return 'Что в ролике, 2–5 строк'
  const photos = files.some((file) => file.media === 'photo')
  const videos = files.some((file) => file.media === 'video')
  if (photos && videos) return 'Что на фото и в видео, 2–5 строк'
  return photos ? 'Что на фото, 2–5 строк' : 'Что в видео, 2–5 строк'
}

/**
 * «Описание» 2–5 строк от КМ (DESIGN §4.20): вход для названия, тегов и текстов, когда
 * будет ИИ. Сохраняется, когда поле теряет фокус.
 */
export function DescriptionField() {
  const { canAct, detail } = useObjectPage()
  const field = useMarkupField('description')
  const save = useFieldSave('description')
  const saved = field?.field.key === 'description' ? field.field.value : ''
  // Введённое держится, пока сервер не вернул это же значение: фон не сбрасывает ввод.
  // Чужая правка того же поля ввод тоже не сбрасывает: сохранение уйдёт с версией, с
  // которой начат ввод, и сервер ответит конфликтом (SPEC §12.0, DESIGN §3.10).
  const [draft, setDraft] = useState<{ text: string; base: number } | null>(null)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    if (draft === null || draft.text.trim() === saved) {
      setDraft(null)
    }
  }

  return (
    <FieldRow
      label="Описание"
      field={field}
      conflict={save.conflict}
      onShowTheirs={() => {
        setDraft(null)
        save.showTheirs()
      }}
      onKeepMine={() => void save.keepMine()}
    >
      {(labelId) =>
        canAct ? (
          <Textarea
            aria-labelledby={labelId}
            rows={2}
            value={draft?.text ?? saved}
            placeholder={descriptionHint(detail.files)}
            onChange={(event) =>
              setDraft({ text: event.target.value, base: draft?.base ?? field?.version ?? 1 })
            }
            onBlur={() => {
              if (draft === null) {
                return
              }
              if (draft.text.trim() === saved) {
                setDraft(null)
                return
              }
              save.save({ key: 'description', value: draft.text.trim() }, draft.base)
            }}
            className="min-h-16"
          />
        ) : (
          <p className={saved ? undefined : 'text-ink-3'}>{saved || 'не заполнено'}</p>
        )
      }
    </FieldRow>
  )
}
