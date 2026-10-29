import {
  BindPostCommandSchema,
  ConfirmCasesCommandSchema,
  ConfirmPairCommandSchema,
  RejectPairCommandSchema,
} from '../../commands/check'
import {
  CaseBatchResultSchema,
  CheckCaseSchema,
  CheckListSchema,
  ResolvedCaseSchema,
  UnverifiedRowSchema,
  UploadCheckResultSchema,
} from '../../domain/check'
import { pageSchema } from '../../domain/pagination'
import { CaseResolutionSchema } from '../responses'
import { defineRoute } from '../route'

/** «Сверить»: cases where Hub doubts or a post went out without plan. */
export const checkRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/reconcile',
    response: CheckListSchema,
  }),
  resolved: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/reconcile/resolved',
    response: pageSchema(ResolvedCaseSchema),
  }),
  notOurs: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/reconcile/not-ours',
    response: pageSchema(ResolvedCaseSchema),
  }),
  /** Rows behind «Hub не смог проверить N», loaded on «Почему». */
  unverified: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/reconcile/unverified',
    response: pageSchema(UnverifiedRowSchema),
  }),
  get: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/reconcile/{case}',
    response: CheckCaseSchema,
  }),
  confirmPair: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile/{case}:confirm-pair',
    body: ConfirmPairCommandSchema,
    response: CaseResolutionSchema,
  }),
  reject: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile/{case}:reject',
    body: RejectPairCommandSchema,
    response: CaseResolutionSchema,
  }),
  bind: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile/{case}:bind',
    body: BindPostCommandSchema,
    response: CaseResolutionSchema,
  }),
  outside: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile/{case}:outside',
    response: CaseResolutionSchema,
  }),
  undo: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile/{case}:undo',
    response: CaseResolutionSchema,
  }),
  checkUpload: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile/{case}:check-upload',
    response: UploadCheckResultSchema,
  }),
  confirmUnambiguous: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/reconcile:confirm-unambiguous',
    body: ConfirmCasesCommandSchema,
    response: CaseBatchResultSchema,
  }),
}
