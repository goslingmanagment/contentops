import { z } from 'zod'
import { IntegrationLineSchema, IntegrationSchema } from '../domain/integrations'
import { ItemIdSchema } from '../domain/item-type'
import { DownloadAnswerSchema, OperationAcceptedSchema } from '../domain/operations'
import { PlacementVerdictSchema } from '../domain/placement'
import { PlanRowSchema, ReleaseSchema } from '../domain/plan'

/** Small answer shapes that exist only on the wire. */

export const OkSchema = z.object({ ok: z.literal(true) })
export type Ok = z.infer<typeof OkSchema>

export const IntegrationViewSchema = IntegrationSchema.extend({ line: IntegrationLineSchema })
export type IntegrationView = z.infer<typeof IntegrationViewSchema>

/** After «Это оно», «Не то», «Привязать», «Не наше»: the new verdict of the placement. */
export const CaseResolutionSchema = z.object({
  case_id: z.string(),
  verdict: PlacementVerdictSchema,
})
export type CaseResolution = z.infer<typeof CaseResolutionSchema>

/** «Залить сейчас»: a row for today and a download named for the page. */
export const UploadNowResultSchema = z.object({
  row: PlanRowSchema,
  download: DownloadAnswerSchema,
})
export type UploadNowResult = z.infer<typeof UploadNowResultSchema>

export const ReleaseResultSchema = z.object({
  release: ReleaseSchema,
  rows: z.array(PlanRowSchema),
})
export type ReleaseResult = z.infer<typeof ReleaseResultSchema>

export const HandoffStartedSchema = OperationAcceptedSchema.extend({ handoff_id: z.string() })
export type HandoffStarted = z.infer<typeof HandoffStartedSchema>

export const ItemCreatedSchema = z.object({ item_id: ItemIdSchema })
export type ItemCreated = z.infer<typeof ItemCreatedSchema>
