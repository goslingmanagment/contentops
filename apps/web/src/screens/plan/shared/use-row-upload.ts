import type { PlanRow, UploadKind } from '@contentops/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUploads, useUploadTarget } from '@/shell/upload/upload-context'
import { sameTarget, type UploadTarget } from '@/shell/upload/upload-target'
import { rowTitle } from './plan-text'

/** Какой файл ждёт строка: монтаж фупа, свой монтаж PPV (новая версия мастера) или тизер. */
const EXPECTED_UPLOAD: Record<
  NonNullable<PlanRow['awaiting_montage']>['expected_type'],
  UploadKind
> = {
  fyp: 'fyp_montage',
  ppv: 'master_version',
  teaser: 'teaser',
}

function rowUploadTarget(row: PlanRow): UploadTarget {
  const where = row.manifest?.item_id ?? rowTitle(row)
  const expected = row.awaiting_montage?.expected_type
  return {
    kind: 'plan-row',
    rowId: row.id,
    title: where,
    expects: expected ? EXPECTED_UPLOAD[expected] : null,
  }
}

/**
 * Цель загрузки на экране Плана (DESIGN §3.7): выбранная строка, строка под
 * перетаскиваемыми файлами или та, у которой нажали «Загрузить монтаж». Окно «Загрузить»
 * открывается, только когда оболочка уже знает цель, — иначе подставилась бы прежняя.
 */
export function useRowUpload(selected: PlanRow | null) {
  const { openUploadDialog } = useUploads()
  const [requested, setRequested] = useState<UploadTarget | null>(null)
  const [dragOver, setDragOver] = useState<UploadTarget | null>(null)
  const selectedTarget = useMemo(() => (selected ? rowUploadTarget(selected) : null), [selected])
  const target = requested ?? dragOver ?? selectedTarget
  useUploadTarget(target)

  // Новая функция открытия приходит от оболочки после того, как она приняла цель.
  const seenOpen = useRef(openUploadDialog)
  useEffect(() => {
    if (requested && seenOpen.current !== openUploadDialog) {
      openUploadDialog()
      setRequested(null)
    }
    seenOpen.current = openUploadDialog
  }, [requested, openUploadDialog])

  return {
    /** «Загрузить монтаж»: окно с этой строкой как целью. */
    uploadFor: (row: PlanRow) => {
      const next = rowUploadTarget(row)
      if (sameTarget(next, target)) {
        openUploadDialog()
      } else {
        setRequested(next)
      }
    },
    /** Файлы тащат над строкой, ждущей монтаж: отпустить — монтаж для неё. */
    setFilesOver: (row: PlanRow, over: boolean) =>
      setDragOver((current) => {
        const next = rowUploadTarget(row)
        if (over) {
          return next
        }
        return sameTarget(current, next) ? null : current
      }),
  }
}
