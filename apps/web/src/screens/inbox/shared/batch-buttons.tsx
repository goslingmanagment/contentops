import { formatNumber, type InboxGroup, ITEM_TYPES } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { ChevronDownIcon } from 'lucide-react'
import { batchModelOf } from './batch'
import { TYPE_WORD } from './group-texts'
import type { IntakeActions } from './use-intake-actions'
import { VIDEO_DESTINATIONS } from './video-destinations'

interface BatchButtonsProps {
  groups: readonly InboxGroup[]
  actions: IntakeActions
  /** `bar` — в тёмной полосе выделения, `panel` — в панели при нескольких выбранных. */
  surface: 'bar' | 'panel'
}

const ids = (groups: readonly InboxGroup[]) => groups.map((group) => group.id)

/** «Тип (1) ▾»: при смешанном выборе видно, к скольким группам кнопка относится. */
function partOf(part: readonly InboxGroup[], all: readonly InboxGroup[]): string {
  return part.length < all.length ? ` (${formatNumber(part.length)})` : ''
}

/**
 * Кнопки пакета (DESIGN §3.3, §4.8): «Принять N» (только готовые), «Тип ▾», «Куда
 * видео ▾», «Слить N». Одни и те же в полосе и в панели; неприменимые не показываются.
 */
export function BatchButtons({ groups, actions, surface }: BatchButtonsProps) {
  const batch = batchModelOf(groups)
  const quiet = surface === 'bar' ? 'bar' : 'outline'
  return (
    <>
      {batch.acceptable.length > 0 ? (
        <Button
          pending={actions.acceptingMany}
          onClick={() => actions.acceptMany(batch.acceptable)}
          className={surface === 'panel' ? 'w-full' : undefined}
        >
          Принять {formatNumber(batch.acceptable.length)}
        </Button>
      ) : null}
      {batch.whatIsIt.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={quiet}>
              Тип{partOf(batch.whatIsIt, groups)}
              <ChevronDownIcon className="-mr-1 size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {ITEM_TYPES.map((type) => (
              <DropdownMenuItem
                key={type}
                onSelect={() => actions.setType(ids(batch.whatIsIt), type)}
              >
                {TYPE_WORD[type]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {batch.videoInSet.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={quiet}>
              Куда видео{partOf(batch.videoInSet, groups)}
              <ChevronDownIcon className="-mr-1 size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {VIDEO_DESTINATIONS.map((destination) => (
              <DropdownMenuItem
                key={destination.value}
                onSelect={() => actions.videoDestination(ids(batch.videoInSet), destination.value)}
              >
                {destination.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {batch.canMerge ? (
        <Button variant={quiet} onClick={() => actions.merge(ids(groups))}>
          Слить {formatNumber(groups.length)}
        </Button>
      ) : null}
    </>
  )
}
