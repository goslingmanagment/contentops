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
import { ResolveDisputeCommandSchema, SaveLabelsCommandSchema } from '../../commands/settings'
import { CreateUploadCommandSchema } from '../../commands/uploads'
import {
  AcceptManyResultSchema,
  AcceptResultSchema,
  InboxGroupSchema,
  InboxListSchema,
  UploadResultSchema,
} from '../../domain/inbox'
import { LegacyReviewSchema } from '../../domain/legacy'
import { DownloadAnswerSchema } from '../../domain/operations'
import { BatchResultSchema } from '../../domain/pagination'
import { defineRoute } from '../route'
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
}
