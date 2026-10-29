import type { Dispute, DisputeOption } from '@contentops/contracts'
import { PROPOSAL_OPTION, UNCLEAR_OPTION } from './use-legacy-actions'

/**
 * Решения спорного случая (DESIGN §4.9): готовое предложение по норме — главной кнопкой
 * («Так и сделать», «Так и сделать: PPV-067», «Привязать к Fansly 3, 04.08»), остальные
 * варианты — рядом, «Неясно — оставить в разборе» — последним.
 */
export interface DisputeChoices {
  primary: DisputeOption | null
  others: readonly DisputeOption[]
  unclear: DisputeOption | null
}

/** Вариант, который повторяет предложение, отдельной кнопкой не показывается. */
const SAME_AS_PROPOSAL: Readonly<Partial<Record<Dispute['kind'], string>>> = {
  label_from_name: 'bind',
}

function proposalLabel(dispute: Dispute, proposal: string): string {
  if (dispute.kind === 'label_from_name') {
    return proposal
  }
  return dispute.kind === 'number_typo' ? `Так и сделать: ${proposal}` : 'Так и сделать'
}

export function disputeChoices(dispute: Dispute): DisputeChoices {
  if (dispute.postponed || dispute.resolved) {
    return { primary: null, others: [], unclear: null }
  }
  const unclear = dispute.options.find((option) => option.key === UNCLEAR_OPTION) ?? null
  // Повтор предложения убирается, только когда предложение есть: иначе он и есть решение.
  const repeat = dispute.proposal ? SAME_AS_PROPOSAL[dispute.kind] : undefined
  const rest = dispute.options.filter(
    (option) => option.key !== UNCLEAR_OPTION && option.key !== repeat,
  )
  if (dispute.proposal) {
    return {
      primary: { key: PROPOSAL_OPTION, label: proposalLabel(dispute, dispute.proposal) },
      others: rest,
      unclear: unclear && { key: unclear.key, label: 'Неясно — оставить в разборе' },
    }
  }
  const [first, ...others] = rest
  return { primary: first ?? null, others, unclear }
}

/** Клавиши `1` `2` `3` по порядку кнопок (DESIGN §3.12). */
export function choiceByDigit(choices: DisputeChoices, digit: number): DisputeOption | null {
  const ordered = [choices.primary, ...choices.others, choices.unclear].filter(
    (option) => option !== null,
  )
  return ordered[digit - 1] ?? null
}
