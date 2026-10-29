import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { ItemMenuButton } from '@contentops/ui/components/item-menu'
import { useNavigate } from '@tanstack/react-router'
import {
  CalendarPlusIcon,
  ClipboardListIcon,
  InfoIcon,
  MegaphoneIcon,
  PackageOpenIcon,
} from 'lucide-react'
import { useMemo } from 'react'
import { useObjectDialogs } from '@/objects/dialogs/use-object-dialogs'
import { useObjectActions } from '@/objects/use-object-actions'
import { useMakePpvDialog } from '@/shell/dialogs/make-ppv-dialog-context'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { useObjectPage } from '../object-context'
import { objectDownloadOptions } from './download-options'
import { useObjectMenu } from './object-menu'

interface ObjectActionsProps {
  info: { open: boolean; onToggle: () => void }
}

/**
 * Справа в шапке объекта: «Скачать ▾», главная синяя кнопка по типу (DESIGN §4.4–4.5),
 * `ⓘ` и «⋯». Главная: «В план»; у кастома, чей заказ сдан без открытых правок, —
 * «Сделать PPV», пока заказ не сдан или ждёт правку — «Открыть заказ»; у подборки —
 * «Подготовить передачу». «Только чтение» видит только `ⓘ` и «⋯».
 */
export function ObjectActions({ info }: ObjectActionsProps) {
  const { detail, canAct, model } = useObjectPage()
  const entry = detail.entry
  const actions = useObjectActions(useMemo(() => [entry], [entry]))
  const dialogs = useObjectDialogs()
  const downloads = useMemo(() => objectDownloadOptions(detail, model.code), [detail, model.code])
  const menu = useObjectMenu(downloads, dialogs.open)

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {canAct && downloads.length > 0 ? (
        <DownloadButton options={downloads} onDownload={actions.download} />
      ) : null}
      {canAct ? <MainAction /> : null}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Сведения"
        aria-pressed={info.open}
        onClick={info.onToggle}
        className="aria-pressed:bg-primary-tint aria-pressed:[&_svg]:text-primary"
      >
        <InfoIcon />
      </Button>
      <ItemMenuButton menu={menu} label="Действия объекта" />
      {dialogs.element}
    </div>
  )
}

function MainAction() {
  const { detail, model } = useObjectPage()
  const navigate = useNavigate()
  const { openPlanDialog } = usePlanDialog()
  const { openMakePpvDialog } = useMakePpvDialog()
  const entry = detail.entry

  if (entry.type === 'custom') {
    if (detail.ready_for_ppv) {
      return (
        <Button onClick={() => openMakePpvDialog(entry.id)}>
          <PackageOpenIcon />
          Сделать PPV
        </Button>
      )
    }
    // Заказ не сдан или ждёт правку: главное — заказ, «Сделать PPV» — в «⋯». Пока свой монтаж
    // для PPV проверяется, главной нет: в шапке ход проверки.
    const order = detail.order
    return order && !entry.ppv_made_as && !detail.ppv_montage ? (
      <Button
        onClick={() =>
          void navigate({
            to: '/$model/library/customs/orders/$order',
            params: { model: model.code, order: order.id },
          })
        }
      >
        <ClipboardListIcon />
        Открыть заказ
      </Button>
    ) : null
  }
  if (entry.type === 'promo') {
    return (
      <Button
        onClick={() =>
          void navigate({
            to: '/$model/library/promo/$channel/$collection',
            params: { model: model.code, channel: entry.channel ?? '', collection: entry.id },
          })
        }
      >
        <MegaphoneIcon />
        Подготовить передачу
      </Button>
    )
  }
  return (
    <Button onClick={() => openPlanDialog([entry.id])}>
      <CalendarPlusIcon />В план
    </Button>
  )
}
