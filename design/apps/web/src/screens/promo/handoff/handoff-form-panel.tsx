import {
  CONTRACTOR_FORMAT_LABEL,
  type CollectionMember,
  type Contractor,
  computeHandoffOverlap,
  formatBytes,
  formatNumber,
  handedTo,
  type PromoCollection,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Label } from '@contentops/ui/components/label'
import { PanelFrame, type PanelFrameWidth } from '@contentops/ui/components/panel-frame'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { Switch } from '@contentops/ui/components/switch'
import { type ReactNode, useId, useState } from 'react'
import { useToday } from '@/data/api-session'
import { usePromoContractors } from '@/data/promo'
import { useCurrentModel } from '@/shell/model/model-context'
import { mediaCounts, memberKey, membersTotals } from '../shared/promo-text'
import { usePromoActions } from '../shared/use-promo-actions'
import { type OverlapChoice, OverlapLine } from './overlap-line'

interface HandoffFormPanelProps {
  collection: PromoCollection
  /** Ключи выбранных в подборке материалов; `null` — передаётся вся подборка. */
  only: readonly string[] | null
  onStarted: (handoffId: string) => void
  onClose: () => void
  width: PanelFrameWidth
  /** Прежние передачи подборки — внизу панели. */
  history: ReactNode
}

/**
 * Подрядчик по умолчанию: закреплённый за подборкой, иначе последний, кому её отдавали,
 * иначе тот, кто работает с этим каналом.
 */
function defaultContractor(
  collection: PromoCollection,
  contractors: readonly Contractor[],
): string | null {
  const last = collection.handoffs.at(-1)?.contractor_id
  const forChannel = contractors.find((contractor) =>
    contractor.channels.includes(collection.channel),
  )
  return collection.contractor_id ?? last ?? forChannel?.id ?? contractors[0]?.id ?? null
}

/** Что передаётся: вся подборка или выбранное в ней. */
function scopeOf(collection: PromoCollection, only: readonly string[] | null): CollectionMember[] {
  if (!only) return collection.members
  const wanted = new Set(only)
  return collection.members.filter((member) => wanted.has(memberKey(member)))
}

/**
 * Шаг 1 передачи (DESIGN §4.17): «Подрядчик ▾» с запомненным форматом, состав, «Стереть
 * метаданные», строка «уже передавали» и «Подготовить». Передаётся вся подборка или
 * выбранное в ней (кнопка в полосе выделения). Ответ — 202: дальше ход виден в лотке и
 * на шаге 2.
 */
export function HandoffFormPanel({
  collection,
  only,
  onStarted,
  onClose,
  width,
  history,
}: HandoffFormPanelProps) {
  const today = useToday()
  const model = useCurrentModel().code
  const actions = usePromoActions()
  const contractors = usePromoContractors(model).data ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const contractorId = picked ?? defaultContractor(collection, contractors)
  const contractor = contractors.find((candidate) => candidate.id === contractorId)
  const [stripMetadata, setStripMetadata] = useState(true)
  // По умолчанию досылается только новое: повтор уходит, лишь если выбрать «Оставить».
  const [choice, setChoice] = useState<OverlapChoice>('drop')
  const stripId = useId()

  const scope = scopeOf(collection, only)
  // Проверка — то же правило, что у сервера (`handoff-check`), по материалам с их передачами.
  const overlap = contractor
    ? computeHandoffOverlap(scope, { id: contractor.id, name: contractor.name }, today)
    : null
  const leaving =
    choice === 'drop' && contractorId
      ? scope.filter((member) => !handedTo(member, contractorId))
      : scope
  const counts = membersTotals(leaving)
  const nothing = leaving.length === 0

  const prepare = () => {
    if (!contractorId) return
    actions.prepare({
      channel: collection.channel,
      collection: collection.id,
      contractor: contractorId,
      stripMetadata,
      excludeAlreadyHanded: choice === 'drop',
      members: only ? scope.map(({ item_id, file_key }) => ({ item_id, file_key })) : null,
      sizeBytes: counts.size_bytes,
      onStarted,
    })
  }

  return (
    <PanelFrame
      label="Подготовить передачу"
      title="Подготовить передачу"
      subtitle={
        <span className="text-muted-foreground">
          {collection.id} · {collection.title}
          {only
            ? ` · выбрано ${formatNumber(scope.length)} из ${formatNumber(collection.members.length)}`
            : null}
        </span>
      }
      width={width}
      onClose={onClose}
      actions={
        <Button
          onClick={prepare}
          disabled={!contractorId || nothing}
          aria-busy={actions.preparing || undefined}
        >
          {actions.preparing ? '…' : 'Подготовить'}
        </Button>
      }
    >
      <InfoSection title="Подрядчик">
        <Select
          value={contractorId ?? undefined}
          onValueChange={(next) => {
            setPicked(next)
            setChoice('drop')
          }}
        >
          <SelectTrigger aria-label="Подрядчик" className="w-full">
            <SelectValue placeholder="Выберите подрядчика" />
          </SelectTrigger>
          <SelectContent>
            {contractors.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {contractor ? (
          <p className="text-muted-foreground text-sm">
            формат: {CONTRACTOR_FORMAT_LABEL[contractor.format]}
          </p>
        ) : null}
      </InfoSection>
      <InfoSection title="Состав">
        <p className="text-base tabular-nums">
          {nothing
            ? scope.length === 0
              ? 'В подборке пока ничего'
              : 'Нового нет — всё уже передавали'
            : `${mediaCounts(counts)} · ≈${formatBytes(counts.size_bytes)}`}
        </p>
        {overlap ? (
          <OverlapLine overlap={overlap} choice={choice} onChoiceChange={setChoice} />
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={stripId} className="font-normal text-base">
            Стереть метаданные
          </Label>
          <Switch id={stripId} checked={stripMetadata} onCheckedChange={setStripMetadata} />
        </div>
      </InfoSection>
      {history}
    </PanelFrame>
  )
}
