import type { ItemFile, LifeAssignment } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { useNavigate } from '@tanstack/react-router'
import { DownloadIcon } from 'lucide-react'
import { useCatalogIndex } from '@/data/catalog'
import { PromoMenu } from '@/objects/promo-menu'
import { useMakePpvDialog } from '@/shell/dialogs/make-ppv-dialog-context'
import { useObjectPage } from '../object-context'
import { frameKey } from './file-keys'
import { useFileSelection } from './file-selection'
import {
  useAssignLife,
  useDownloadFiles,
  useExtractShoot,
  useMakeCover,
  useMakePhotos,
  usePickFrames,
  useRemoveFiles,
} from './use-file-commands'
import { useAddFilesToPromo, useRemoveFromCollection } from './use-promo-files'

const LIFE_BUTTONS: readonly { value: LifeAssignment; label: string }[] = [
  { value: 'feed', label: 'В ленту' },
  { value: 'chats', label: 'В чаты' },
  { value: 'both', label: 'Оба' },
]

interface SelectedFiles {
  /** Все выбранные ключи: файлы и кадры мастера. */
  keys: string[]
  /** Выбранные файлы объекта (без кадров мастера). */
  files: ItemFile[]
}

/**
 * Полоса выделения файлов объекта (DESIGN §3.3): «Скачать», «Сделать обложкой» (один),
 * «Сделать фото» (кадры мастера), «В промо ▾»; у лайфа — «В ленту», «В чаты», «Оба», у
 * сырья — «Сделать мастером PPV» и «Выделить в новую съёмку», у подборки — «Подготовить
 * передачу» и «Убрать из подборки». Неприменимого нет.
 */
export function FileSelectionBar() {
  const { detail, canAct } = useObjectPage()
  const selection = useFileSelection()
  const selected: SelectedFiles = {
    keys: [...selection.keys],
    files: detail.files.filter((file) => selection.keys.has(file.key)),
  }
  const menu = useBarMenu(selected.files)
  const Actions = detail.entry.type === 'promo' ? PromoActions : FileActions
  return (
    <SelectionBar
      count={selected.keys.length}
      onClear={selection.clear}
      menu={canAct ? menu : undefined}
    >
      {canAct ? <Actions {...selected} /> : null}
    </SelectionBar>
  )
}

/** Материалы подборки промо: передача и «Убрать из подборки». */
function PromoActions({ keys }: SelectedFiles) {
  const { detail, model } = useObjectPage()
  const navigate = useNavigate()
  const removeFromCollection = useRemoveFromCollection()
  return (
    <>
      <Button
        onClick={() =>
          void navigate({
            to: '/$model/library/promo/$channel/$collection',
            params: {
              model: model.code,
              channel: detail.entry.channel ?? '',
              collection: detail.entry.id,
            },
          })
        }
      >
        Подготовить передачу
      </Button>
      <Button variant="bar" onClick={() => removeFromCollection(keys)}>
        Убрать из подборки
      </Button>
    </>
  )
}

function FileActions({ keys, files }: SelectedFiles) {
  const { detail, model } = useObjectPage()
  const download = useDownloadFiles()
  const makePhotos = useMakePhotos()
  const assign = useAssignLife()
  const extract = useExtractShoot()
  const addToPromo = useAddFilesToPromo()
  const { openMakePpvDialog } = useMakePpvDialog()
  const collections = (useCatalogIndex(model.code).data?.items ?? []).filter(
    (entry) => entry.type === 'promo',
  )
  const type = detail.entry.type
  const fileKeys = files.map((file) => file.key)
  const frames = detail.frames
    .map((frame, index) => ({ ...frame, key: frameKey(index) }))
    .filter((frame) => keys.includes(frame.key))
  const onlyFrames = frames.length > 0 && frames.length === keys.length
  const singleVideo = files.length === 1 && keys.length === 1 && files[0]?.media === 'video'

  return (
    <>
      {fileKeys.length > 0 ? (
        <Button onClick={() => download(fileKeys)}>
          <DownloadIcon />
          Скачать
        </Button>
      ) : null}
      {type === 'life'
        ? LIFE_BUTTONS.map((button) => (
            <Button key={button.value} variant="bar" onClick={() => assign(keys, button.value)}>
              {button.label}
            </Button>
          ))
        : null}
      {onlyFrames ? (
        <Button
          onClick={() =>
            makePhotos({
              frames: frames.map((frame) => frame.t_s),
              keys: frames.map((frame) => frame.key),
            })
          }
        >
          Сделать фото
        </Button>
      ) : null}
      <CoverButton keys={keys} files={files} />
      {type === 'raw' && singleVideo ? (
        <Button variant="bar" onClick={() => openMakePpvDialog(detail.entry.id)}>
          Сделать мастером PPV
        </Button>
      ) : null}
      {type === 'raw' ? (
        <Button variant="bar" onClick={() => extract(keys)}>
          Выделить в новую съёмку
        </Button>
      ) : null}
      {fileKeys.length > 0 && type !== 'raw' ? (
        <PromoMenu variant="bar" collections={collections} onAdd={addToPromo} />
      ) : null}
    </>
  )
}

/** «Сделать обложкой» — у одного кадра мастера или одного фото. */
function CoverButton({ keys, files }: SelectedFiles) {
  const { detail } = useObjectPage()
  const makeCover = useMakeCover()
  const key = keys.length === 1 ? keys[0] : undefined
  if (!key) {
    return null
  }
  const frame = detail.frames.find((_, index) => frameKey(index) === key)
  const photo = files.find((file) => file.key === key && file.media === 'photo')
  if (!frame && !photo) {
    return null
  }
  return (
    <Button
      variant="bar"
      onClick={() =>
        makeCover({
          command: frame ? { from: 'frame', t_s: frame.t_s } : { from: 'file', key },
          key,
        })
      }
    >
      Сделать обложкой
    </Button>
  )
}

/** «⋯» полосы: «Убрать из отобранных» у сета, «Снять назначение» у лайфа, «Убрать из объекта…». */
function useBarMenu(files: ItemFile[]): ItemMenuModel {
  const { detail } = useObjectPage()
  const pick = usePickFrames()
  const assign = useAssignLife()
  const remove = useRemoveFiles()
  const keys = files.map((file) => file.key)
  const picked = files.filter((file) => file.selected).map((file) => file.key)
  const actions: MenuAction[] = []
  if (detail.entry.type === 'set' && picked.length > 0) {
    actions.push({
      id: 'unpick',
      label: 'Убрать из отобранных',
      onSelect: () => pick(picked, false),
    })
  }
  if (detail.entry.type === 'life' && keys.length > 0) {
    actions.push({ id: 'unassign', label: 'Снять назначение', onSelect: () => assign(keys, null) })
  }
  const removable = files.filter((file) => file.role !== 'master').map((file) => file.key)
  return {
    actions,
    dangerActions:
      removable.length > 0
        ? [{ id: 'remove', label: 'Убрать из объекта…', onSelect: () => remove(removable) }]
        : undefined,
  }
}
