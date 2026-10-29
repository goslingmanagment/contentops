import { z } from 'zod'
import {
  CancelRowCommandSchema,
  CreatePlanRowsCommandSchema,
  CreatePlanRowsResultSchema,
  CreateReleaseCommandSchema,
  MarkConfirmRowCommandSchema,
  MarkConfirmRowsCommandSchema,
  MarkRowCommandSchema,
  MarkRowsCommandSchema,
  MoveRowCommandSchema,
  NewPlanRowSchema,
  PlanDownloadCommandSchema,
  RowCheckResultSchema,
  UpdateRowCommandSchema,
  UpdateWeekNormCommandSchema,
} from '../../commands/plan'
import { IsoWeekSchema, LocalDateSchema } from '../../domain/common'
import { DownloadAnswerSchema } from '../../domain/operations'
import { BatchResultSchema } from '../../domain/pagination'
import { PlanDaySchema, PlanRowSchema, PlanWeekSchema, WeekNormSchema } from '../../domain/plan'
import { OkSchema, ReleaseResultSchema } from '../responses'
import { defineRoute, QueryFlagSchema } from '../route'

/** Plan: day and week views, rows and their marks, releases, week norms. */
export const planRoutes = {
  day: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/plan',
    query: z.object({
      date: LocalDateSchema,
      mine: QueryFlagSchema.optional(),
      /** «Отменённые · 2»: cancelled rows of the day come in `rows` too. */
      cancelled: QueryFlagSchema.optional(),
    }),
    response: PlanDaySchema,
  }),
  week: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/plan',
    query: z.object({ week: IsoWeekSchema }),
    response: PlanWeekSchema,
  }),
  row: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/plan/rows/{row}',
    response: PlanRowSchema,
    versioned: true,
  }),
  createRows: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows',
    query: z.object({ dry_run: QueryFlagSchema.optional() }),
    body: CreatePlanRowsCommandSchema,
    response: CreatePlanRowsResultSchema,
    success: 201,
  }),
  checkRow: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows:check',
    body: NewPlanRowSchema,
    response: RowCheckResultSchema,
  }),
  undoCreate: defineRoute({
    method: 'DELETE',
    path: '/api/v1/{model}/plan/rows/{row}',
    response: OkSchema,
  }),
  updateRow: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/plan/rows/{row}',
    body: UpdateRowCommandSchema,
    response: PlanRowSchema,
    versioned: true,
  }),
  mark: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:mark',
    body: MarkRowCommandSchema,
    response: PlanRowSchema,
  }),
  markConfirm: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:mark-confirm',
    body: MarkConfirmRowCommandSchema,
    response: PlanRowSchema,
  }),
  unmark: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:unmark',
    response: PlanRowSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:cancel',
    body: CancelRowCommandSchema,
    response: PlanRowSchema,
  }),
  move: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:move',
    body: MoveRowCommandSchema,
    response: PlanRowSchema,
    versioned: true,
  }),
  markMany: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows:mark',
    body: MarkRowsCommandSchema,
    response: BatchResultSchema,
  }),
  markConfirmMany: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows:mark-confirm',
    body: MarkConfirmRowsCommandSchema,
    response: BatchResultSchema,
  }),
  createRelease: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/releases',
    body: CreateReleaseCommandSchema,
    response: ReleaseResultSchema,
    success: 201,
  }),
  download: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/downloads',
    body: PlanDownloadCommandSchema,
    response: DownloadAnswerSchema,
    success: 202,
  }),
  norm: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/accounts/{account}/week-norm',
    response: WeekNormSchema,
    versioned: true,
  }),
  updateNorm: defineRoute({
    method: 'PUT',
    path: '/api/v1/{model}/accounts/{account}/week-norm',
    body: UpdateWeekNormCommandSchema,
    response: WeekNormSchema,
    versioned: true,
  }),
}
