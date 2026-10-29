import type { ItemFile } from '@contentops/contracts'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { useCallback } from 'react'
import { useObjectPage } from '../object-context'
import { useDownloadFiles, useMakeCover, useRemoveFiles } from './use-file-commands'

/**
 * Меню файла в объекте — «⋯» и правый клик (DESIGN §3.6): Открыть · Скачать · Сделать
 * обложкой · Сравнить с… · Версии · — · Убрать из объекта… Неприменимое не показывается.
 */
export function useFileMenu(): (file: ItemFile) => ItemMenuModel {
  const { canAct, openFile, setSearch } = useObjectPage()
  const download = useDownloadFiles()
  const makeCover = useMakeCover()
  const remove = useRemoveFiles()

  return useCallback(
    (file: ItemFile) => {
      const open: MenuAction = { id: 'open', label: 'Открыть', onSelect: () => openFile(file.key) }
      if (!canAct) {
        return { actions: [open] }
      }
      const versions = file.versions.length > 1
      const actions: MenuAction[] = [
        open,
        { id: 'download', label: 'Скачать', onSelect: () => download([file.key]) },
        ...(file.media === 'photo'
          ? [
              {
                id: 'cover',
                label: 'Сделать обложкой',
                onSelect: () =>
                  makeCover({ command: { from: 'file', key: file.key }, key: file.key }),
              },
            ]
          : []),
        ...(versions
          ? [
              {
                id: 'compare',
                label: 'Сравнить с…',
                onSelect: () => setSearch({ compare: 'v1,v2', view: file.key }),
              },
              { id: 'versions', label: 'Версии', onSelect: () => setSearch({ tab: 'history' }) },
            ]
          : []),
      ]
      return {
        actions,
        dangerActions:
          file.role === 'master'
            ? undefined
            : [
                {
                  id: 'remove',
                  label: 'Убрать из объекта…',
                  onSelect: () => remove([file.key]),
                },
              ],
      }
    },
    [canAct, download, makeCover, openFile, remove, setSearch],
  )
}
