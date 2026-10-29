import {
  type ItemDetail,
  type NewProvenanceLink,
  PROVENANCE_LABEL,
  type ProvenanceLink,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { ItemMenuButton } from '@contentops/ui/components/item-menu'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useActionToast } from '@/actions/action-toast-context'
import { useHref } from '@/app/use-href'
import { useApi } from '@/data/api-session'
import { useItemCommand } from '../actions/use-item-command'
import { useObjectPage } from '../object-context'
import { AddLinkPopover } from './add-link-popover'

type LinkCommand =
  | { kind: 'add'; link: NewProvenanceLink }
  | { kind: 'confirm'; id: string }
  | { kind: 'remove'; id: string }

const DONE: Record<LinkCommand['kind'], string> = {
  add: 'Связь добавлена',
  confirm: 'Связь подтверждена',
  remove: 'Связь убрана',
}

function useLinkCommands() {
  const { detail, model } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const params = { model: model.code, id: detail.entry.id }
  return useItemCommand<LinkCommand>({
    failed: 'Связь не сохранилась',
    run: (command, idempotencyKey): Promise<ItemDetail> => {
      if (command.kind === 'add') {
        return api.objects.addLink({ params, body: command.link, idempotencyKey })
      }
      const linkParams = { ...params, link: command.id }
      return command.kind === 'confirm'
        ? api.objects.confirmLink({ params: linkParams, idempotencyKey })
        : api.objects.removeLink({ params: linkParams, idempotencyKey })
    },
    onSaved: (_saved, command) => toast.show({ message: DONE[command.kind] }),
  })
}

/**
 * Происхождение в обе стороны (DESIGN §4.4): «Сделано из → Съёмка 6 августа · RAW-0034»,
 * «Из него → Reddit, август · PRM-014». Неподтверждённая связь — ◆ и «Подтвердить /
 * Убрать»; «+ Связь…» — вид связи и поиск объекта.
 */
export function ProvenanceSection() {
  const { detail, canAct } = useObjectPage()
  const commands = useLinkCommands()
  const links = detail.provenance
  return (
    <InfoSection
      title="Происхождение"
      aside={
        canAct ? (
          <AddLinkPopover onAdd={(link) => commands.start({ kind: 'add', link })} />
        ) : undefined
      }
    >
      {links.length === 0 ? (
        <p className="text-ink-3">Связей нет</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {links.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              canAct={canAct}
              onConfirm={() => commands.start({ kind: 'confirm', id: link.id })}
              onRemove={() => commands.start({ kind: 'remove', id: link.id })}
            />
          ))}
        </ul>
      )}
    </InfoSection>
  )
}

interface LinkRowProps {
  link: ProvenanceLink
  canAct: boolean
  onConfirm: () => void
  onRemove: () => void
}

/** «Reddit» после «Reddit, август» не повторяется. */
function linkTitle(link: ProvenanceLink): string {
  return link.extra && !link.item_title.includes(link.extra)
    ? `${link.item_title} · ${link.extra}`
    : link.item_title
}

function LinkRow({ link, canAct, onConfirm, onRemove }: LinkRowProps) {
  const { model } = useObjectPage()
  const href = useHref()
  return (
    <li className="group/link flex min-w-0 items-start gap-1.5">
      {link.confirmed ? null : <StatusSign kind="turn" className="mt-0.5 shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-ink-3 text-xs">
          {PROVENANCE_LABEL[link.relation][link.direction]}
        </span>
        <UiLink
          href={href({ to: '/$model/i/$id', params: { model: model.code, id: link.item_id } })}
          className="flex min-w-0 text-primary-ink hover:underline"
        >
          <span className="truncate">{linkTitle(link)}</span>
          <span className="shrink-0 whitespace-pre text-ink-3 tabular-nums"> · {link.item_id}</span>
        </UiLink>
        {canAct && !link.confirmed ? (
          <div className="flex gap-3 text-sm">
            <Button variant="link" size="inline" onClick={onConfirm}>
              Подтвердить
            </Button>
            <Button variant="link" size="inline" onClick={onRemove}>
              Убрать
            </Button>
          </div>
        ) : null}
      </div>
      {canAct && link.confirmed ? (
        <ItemMenuButton
          size="icon-sm"
          label="Действия связи"
          className="opacity-0 group-hover/link:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
          menu={{ actions: [{ id: 'remove', label: 'Убрать связь…', onSelect: onRemove }] }}
        />
      ) : null}
    </li>
  )
}
