import { z } from 'zod'
import { IntegrationSwitchesSchema } from '../domain/integrations'
import { LabelTargetSchema } from '../domain/legacy'
import { ThresholdSchema, ThresholdScopeSchema } from '../domain/system'

export const UpdateIntegrationCommandSchema = z.object({ switches: IntegrationSwitchesSchema })
export type UpdateIntegrationCommand = z.infer<typeof UpdateIntegrationCommandSchema>

/** Which threshold row: the one for everything or an exception for a model, page or type. */
const THRESHOLD_ROW = {
  key: ThresholdSchema.shape.key,
  scope: ThresholdScopeSchema.default('all'),
  scope_value: z.string().min(1).nullable().default(null),
}

function scopeHasValue(row: { scope: string; scope_value: string | null }): boolean {
  return (row.scope === 'all') === (row.scope_value === null)
}

const SCOPE_VALUE_ISSUE = {
  message: 'У области «всё» нет значения, у исключения оно есть',
  path: ['scope_value'],
}

/** Sets a threshold; a new exception is created without `If-Match`, the rest need it. */
export const UpdateThresholdCommandSchema = z
  .object({ ...THRESHOLD_ROW, value: z.number().nonnegative().nullable() })
  .refine(scopeHasValue, SCOPE_VALUE_ISSUE)
export type UpdateThresholdCommand = z.infer<typeof UpdateThresholdCommandSchema>

/** Removes an exception; the row for everything stays (an empty value turns it off). */
export const RemoveThresholdCommandSchema = z
  .object(THRESHOLD_ROW)
  .refine(scopeHasValue, SCOPE_VALUE_ISSUE)
export type RemoveThresholdCommand = z.infer<typeof RemoveThresholdCommandSchema>

export const IssueTokenCommandSchema = z.object({
  agent_id: z.string(),
  expires_in_days: z.int().positive().nullable(),
})
export type IssueTokenCommand = z.infer<typeof IssueTokenCommandSchema>

/** «Метки старых имён → страницы», saved once. */
export const SaveLabelsCommandSchema = z.object({
  labels: z.array(z.object({ label: z.string(), target: LabelTargetSchema.nullable() })).min(1),
})
export type SaveLabelsCommand = z.infer<typeof SaveLabelsCommandSchema>

export const ResolveDisputeCommandSchema = z.object({
  option: z.string(),
  /** «Номер занят», выбор у каждой папки: имя папки → вариант (`keep`, `new_number`…). */
  folders: z.record(z.string(), z.string()).optional(),
})
export type ResolveDisputeCommand = z.infer<typeof ResolveDisputeCommandSchema>
