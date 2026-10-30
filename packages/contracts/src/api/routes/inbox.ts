import { z } from 'zod'
import {
  AcceptCommandSchema,
  DecideCommandSchema,
  GroupIdsCommandSchema,
  MergeGroupsCommandSchema,
  RejectGroupCommandSchema,
  SetGroupsTypeCommandSchema,
  SplitGroupCommandSchema,
  UpdateDraftCommandSchema,
  UpdateDraftFilesCommandSchema,
} from '../../commands/inbox'
import {
  ResolveDisputeCommandSchema,
  SaveLabelsCommandSchema,
  UpdateLegacyInputsCommandSchema,
} from '../../commands/settings'
import { CreateUploadCommandSchema } from '../../commands/uploads'
import {
  AcceptManyResultSchema,
  AcceptResultSchema,
  InboxGroupSchema,
  InboxListSchema,
  UploadResultSchema,
} from '../../domain/inbox'
import { LegacyInputsSchema, LegacyReviewSchema } from '../../domain/legacy'
import { DownloadAnswerSchema, OperationAcceptedSchema } from '../../domain/operations'
import { BatchResultSchema } from '../../domain/pagination'
import { defineRoute, QueryListSchema } from '../route'
import { FileBodySchema } from './media'

export const InboxQuerySchema = z.object({
  /** `active` — «Новое»; `accepted`, `rejected` — «Решённое». */
  state: z.enum(['active', 'accepted', 'rejected']).optional(),
})

/** «Приехало»: groups, decisions, accepting, and «Разбор старого». */
export const inboxRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/inbox',
    query: InboxQuerySchema,
    response: InboxListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/inbox/groups/{group}',
    response: InboxGroupSchema,
    versioned: true,
  }),
  update: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/inbox/groups/{group}',
    body: UpdateDraftCommandSchema,
    response: InboxGroupSchema,
    versioned: true,
  }),
  /** Roles and order of the files: the role chip menu and photos moved by drag. */
  files: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/inbox/groups/{group}/files',
    body: UpdateDraftFilesCommandSchema,
    response: InboxGroupSchema,
    versioned: true,
  }),
  /** «Скачать исходник»: one file at once, several files as a ZIP in the tray (202). */
  download: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups/{group}/downloads',
    response: DownloadAnswerSchema,
  }),
  /**
   * `download_url` of «Скачать исходник»: one file of the group (`file` = its key) or the ZIP
   * the operation built (`zip` = the operation); no receipt — a draft has no ID (schema §9.2).
   */
  source: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/inbox/groups/{group}/source',
    query: z.object({ file: z.string().optional(), zip: z.string().optional() }),
    response: FileBodySchema,
  }),
  decide: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups/{group}:decide',
    body: DecideCommandSchema,
    response: InboxGroupSchema,
  }),
  accept: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups/{group}:accept',
    body: AcceptCommandSchema,
    response: AcceptResultSchema,
  }),
  acceptMany: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups:accept',
    body: GroupIdsCommandSchema,
    response: AcceptManyResultSchema,
  }),
  setType: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups:set-type',
    body: SetGroupsTypeCommandSchema,
    response: BatchResultSchema,
  }),
  merge: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups:merge',
    body: MergeGroupsCommandSchema,
    response: InboxGroupSchema,
  }),
  split: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups/{group}:split',
    body: SplitGroupCommandSchema,
    response: InboxGroupSchema,
    success: 201,
  }),
  reject: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups/{group}:reject',
    body: RejectGroupCommandSchema,
    response: InboxGroupSchema,
  }),
  retry: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/groups/{group}:retry',
    response: InboxGroupSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/inbox/drafts/{group}:restore',
    response: InboxGroupSchema,
  }),
  /**
   * The last step of a web upload (DESIGN §3.7): with a target the files are accepted into
   * it by themselves and «принято при загрузке» goes to «Решённое»; «Другое» becomes a
   * group «Загружено вами» in «Приехало».
   */
  upload: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/uploads',
    body: CreateUploadCommandSchema,
    response: UploadResultSchema,
    success: 201,
  }),
}

export const LegacyRunQuerySchema = z.object({
  /** Work id of a finished snapshot `scan:freeze:<date>`; the latest one when left out. */
  snapshot: z.string().optional(),
})

export const LegacyBytesQuerySchema = LegacyRunQuerySchema.extend({
  /** Top folders of the old disk, in the order of SPEC §6.3: `1. PPV`, `5. Sextings`; can repeat. */
  root: QueryListSchema,
  /** One folder inside them; the whole roots when left out. */
  folder: z.string().optional(),
  /** `true` — out of the order of the norm (one folder again, a test). */
  force: z.enum(['true', 'false']).optional(),
})

export const legacyRoutes = {
  get: defineRoute({ method: 'GET', path: '/api/v1/{model}/legacy', response: LegacyReviewSchema }),
  saveLabels: defineRoute({
    method: 'PUT',
    path: '/api/v1/{model}/legacy/labels',
    body: SaveLabelsCommandSchema,
    response: LegacyReviewSchema,
  }),
  resolve: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/legacy/disputes/{dispute}:resolve',
    body: ResolveDisputeCommandSchema,
    response: LegacyReviewSchema,
  }),
  /**
   * The metadata pass of stage 3 over a frozen snapshot (SPEC §6.3, work `import_parse`): claims,
   * number claims, review cases, then the reserve of numbers. The latest snapshot of the model
   * unless `snapshot` names one; a repeat with the same rules finds the same work.
   */
  parse: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/legacy:parse',
    query: LegacyRunQuerySchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  /** The dry run `import plan` (PLAN этап 3): the same parse, only the report in the operation. */
  plan: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/legacy:plan',
    query: LegacyRunQuerySchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  /**
   * The bytes of the old corpus, root by root (SPEC §6.3): groups and drafts of the snapshot's
   * revisions, their bytes from the local copy or the API, archives unpacked, groups without a
   * dispute accepted by themselves. A repeat accepts what became ready and changes nothing else.
   */
  bytes: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/legacy:bytes',
    query: LegacyBytesQuerySchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  /** The reconciliation with the snapshot (SPEC §6.3 «Сверка»): the report in the operation. */
  reconcile: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/legacy:reconcile',
    query: LegacyRunQuerySchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  /** The PPV registry export and the vault album titles the import reads (schema §9.7). */
  inputs: defineRoute({
    method: 'PUT',
    path: '/api/v1/{model}/legacy/inputs',
    body: UpdateLegacyInputsCommandSchema,
    response: LegacyInputsSchema,
  }),
}
