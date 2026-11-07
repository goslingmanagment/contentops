import { logAction, type Tx } from '@contentops/db'
import type { ProviderName, Stage } from '@contentops/vision'

/**
 * The receipt of every request to a provider (SPEC §8.3): provider, model, version of the
 * settings, route, the frames sent by reference, hash and size of the sent body, outcome and
 * price — never the content. An `action` row of the system in the journal (DESIGN §4.20
 * «Квитанции запросов … события системы с ценой»); a stop before any request gets its own row.
 */

export const STAGE_WORD: Record<Stage, string> = {
  observe: 'кадры',
  aggregate: 'поля',
  texts: 'тексты',
}

export type ReceiptOutcome =
  | 'answered'
  | 'partial'
  | 'refused'
  | 'auth_rejected'
  | 'rate_limited'
  | 'transient'
  | 'bad_request'
  | 'bad_response'
  | 'unknown'

export interface Receipt {
  runId: string
  modelId: string
  itemId: string
  publicId: string
  stage: Stage
  provider: ProviderName
  model: string
  attempt: number
  route: string
  configDigest: string
  /** `rendition_artifacts.id` of each frame sent, in the order sent. */
  frames: readonly string[]
  sent: { sha256: Buffer; bytes: number } | null
  outcome: ReceiptOutcome
  costUsd: number | null
  requestId: string | null
  tokens: { input_tokens: number; output_tokens: number } | null
  workId: string | null
}

export function receiptSubject(publicId: string, stage: Stage, provider: string, model: string) {
  return `${publicId} · ${STAGE_WORD[stage]} · ${provider} ${model}`
}

export async function logReceipt(tx: Tx, receipt: Receipt): Promise<void> {
  await logAction(tx, {
    modelId: receipt.modelId,
    action: 'annotation.request',
    itemId: receipt.itemId,
    workId: receipt.workId,
    subjectKind: 'annotation_runs',
    subjectId: receipt.runId,
    subjectLabel: receiptSubject(receipt.publicId, receipt.stage, receipt.provider, receipt.model),
    after: {
      provider: receipt.provider,
      model: receipt.model,
      attempt: receipt.attempt,
      route: receipt.route,
      settings: receipt.configDigest.slice(0, 16),
      frames: receipt.frames,
      sent_sha256: receipt.sent ? receipt.sent.sha256.toString('hex') : null,
      sent_bytes: receipt.sent?.bytes ?? null,
      outcome: receipt.outcome,
      cost_usd: receipt.costUsd === null ? null : receipt.costUsd.toFixed(6),
      request_id: receipt.requestId,
      tokens_in: receipt.tokens?.input_tokens ?? null,
      tokens_out: receipt.tokens?.output_tokens ?? null,
    },
    result: ['answered', 'partial', 'refused'].includes(receipt.outcome) ? 'ok' : 'error',
  })
}

/** Nothing was sent: a policy kept the request back (SPEC §8.3 «исключение по политике»). */
export async function logHeldBack(
  tx: Tx,
  input: {
    modelId: string
    itemId: string
    publicId: string
    stage: Stage
    provider: ProviderName
    model: string
    reason: string
    workId: string | null
  },
): Promise<void> {
  await logAction(tx, {
    modelId: input.modelId,
    action: 'annotation.held',
    itemId: input.itemId,
    workId: input.workId,
    subjectKind: 'content_items',
    subjectId: input.itemId,
    subjectLabel: receiptSubject(input.publicId, input.stage, input.provider, input.model),
    after: { reason: input.reason },
  })
}
