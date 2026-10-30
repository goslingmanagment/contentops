import { z } from 'zod'
import {
  AlreadyUploadedCommandSchema,
  ChangeTypeCommandSchema,
  ConfirmMarkupCommandSchema,
  DeleteItemCommandSchema,
  DownloadCommandSchema,
  MakePpvCommandSchema,
  SaveFrameCheckCommandSchema,
  SetItemFlagsCommandSchema,
  UploadNowCommandSchema,
} from '../../commands/objects'
import {
  CatalogEntrySchema,
  CatalogIndexSchema,
  DeletedItemSchema,
  PageSummaryIndexSchema,
  PpvKindSchema,
  RecentItemSchema,
} from '../../domain/catalog'
import { AccountCodeSchema } from '../../domain/common'
import { ItemDetailSchema, MakePpvResultSchema } from '../../domain/item'
import { ItemTypeSchema } from '../../domain/item-type'
import { MarkupValueSchema } from '../../domain/markup'
import { DownloadAnswerSchema } from '../../domain/operations'
import { BatchResultSchema, PageQuerySchema, pageSchema } from '../../domain/pagination'
import { NewProvenanceLinkSchema } from '../../domain/provenance'
import { NotUploadedPageSchema, ResolveResultSchema, SearchResultSchema } from '../../domain/search'
import { ItemCreatedSchema, OkSchema, UploadNowResultSchema } from '../responses'
import { defineRoute, QueryListSchema } from '../route'

export const ItemsQuerySchema = PageQuerySchema.extend({
  type: ItemTypeSchema.optional(),
  /** `lora-2:no`, `lora-1:yes` — the «Где залито» chip, can repeat. */
  where: QueryListSchema.optional(),
  kind: PpvKindSchema.optional(),
  tag: QueryListSchema.optional(),
})

/** Catalog of a model: the two index resources, lists, the object page and its commands. */
export const objectRoutes = {
  catalogIndex: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/index',
    response: CatalogIndexSchema,
  }),
  pageSummaries: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/index/pages',
    response: PageSummaryIndexSchema,
  }),
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/items',
    query: ItemsQuerySchema,
    response: pageSchema(CatalogEntrySchema),
  }),
  recent: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/recent',
    response: pageSchema(RecentItemSchema),
  }),
  deleted: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/deleted',
    response: pageSchema(DeletedItemSchema),
  }),
  resolve: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/resolve',
    query: z.object({ q: z.string() }),
    response: ResolveResultSchema,
  }),
  search: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/search',
    query: z.object({ q: z.string() }),
    response: SearchResultSchema,
  }),
  notUploaded: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/not-uploaded',
    query: z.object({ account: AccountCodeSchema }),
    response: NotUploadedPageSchema,
  }),
  alreadyUploaded: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/not-uploaded:mark',
    body: AlreadyUploadedCommandSchema,
    response: BatchResultSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/i/{id}',
    response: ItemDetailSchema,
    versioned: true,
  }),
  updateField: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/i/{id}/fields/{field}',
    body: MarkupValueSchema,
    response: ItemDetailSchema,
    versioned: true,
  }),
  confirmMarkup: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/markup:confirm',
    body: ConfirmMarkupCommandSchema,
    response: ItemDetailSchema,
  }),
  setFlags: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/i/{id}/flags',
    body: SetItemFlagsCommandSchema,
    response: ItemDetailSchema,
    versioned: true,
  }),
  saveFrameCheck: defineRoute({
    method: 'PUT',
    path: '/api/v1/{model}/i/{id}/frame-check',
    body: SaveFrameCheckCommandSchema,
    response: ItemDetailSchema,
    versioned: true,
  }),
  download: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/downloads',
    body: DownloadCommandSchema,
    response: DownloadAnswerSchema,
  }),
  addLink: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/links',
    body: NewProvenanceLinkSchema,
    response: ItemDetailSchema,
    success: 201,
  }),
  confirmLink: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/links/{link}:confirm',
    response: ItemDetailSchema,
  }),
  removeLink: defineRoute({
    method: 'DELETE',
    path: '/api/v1/{model}/i/{id}/links/{link}',
    response: ItemDetailSchema,
  }),
  uploadNow: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:upload-now',
    body: UploadNowCommandSchema,
    response: UploadNowResultSchema,
    success: 201,
  }),
  makePpv: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:make-ppv',
    body: MakePpvCommandSchema,
    response: MakePpvResultSchema,
    success: 201,
  }),
  changeType: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:change-type',
    body: ChangeTypeCommandSchema,
    response: ItemCreatedSchema,
    versioned: true,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/api/v1/{model}/i/{id}',
    body: DeleteItemCommandSchema,
    response: OkSchema,
    versioned: true,
  }),
  /** «Вернуть» a deleted object: the tombstone goes, the number stays (SPEC §4.1). */
  restore: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:restore',
    response: ItemDetailSchema,
  }),
}
