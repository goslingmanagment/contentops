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
  PrepareRowsCommandSchema,
  RowCheckResultSchema,
  SendPublicationCommandSchema,
  SendRowsCommandSchema,
  UpdateRowCommandSchema,
  UpdateWeekNormCommandSchema,
} from '../../commands/plan'
import { IsoWeekSchema, LocalDateSchema } from '../../domain/common'
import { DownloadAnswerSchema } from '../../domain/operations'
import { BatchResultSchema } from '../../domain/pagination'
import {
  PlanDaySchema,
  PlanHubSchema,
  PlanRowSchema,
  PlanWeekSchema,
  WeekNormSchema,
} from '../../domain/plan'
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
  /**
   * Publication through Hub (5б, SPEC §7): «Подготовить» — Hub gets the missing files and makes a
   * draft with its checks; a person and an agent may prepare. The work runs in the background:
   * the row answers with `hub.pending`.
   */
  prepare: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:prepare',
    response: PlanRowSchema,
    success: 202,
  }),
  /**
   * «Отправить»: a person who saw Hub's checks confirms, ContentOps approves the draft of that
   * version. An agent never sends (SPEC §11.1): 403.
   */
  send: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:send',
    body: SendPublicationCommandSchema,
    response: PlanRowSchema,
    success: 202,
  }),
  /**
   * Takes ContentOps' own publication off while Hub has not handed it to the platform (7 days
   * before it goes out); later only the owner, in Hub. The row stays in the plan.
   */
  cancelPublication: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows/{row}:cancel-publication',
    response: PlanRowSchema,
    success: 202,
  }),
  /**
   * «Подготовить 12» (DESIGN §4.11): each row on its own, `{results: [{id, ok, code}]}`; a row
   * Hub does not publish stays with its code.
   */
  prepareMany: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows:prepare',
    body: PrepareRowsCommandSchema,
    response: BatchResultSchema,
    success: 202,
  }),
  /**
   * «Отправить 12» after one window with the summary of Hub's checks: rows with a blocking
   * check stay (`publication_blocked`), the rest go. A person only: an agent gets 403.
   */
  sendMany: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/plan/rows:send',
    body: SendRowsCommandSchema,
    response: BatchResultSchema,
    success: 202,
  }),
  /** The publication of the row as the row shows it: status, Hub's checks, what may be done. */
  publication: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/plan/rows/{row}/publication',
    response: PlanHubSchema,
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
