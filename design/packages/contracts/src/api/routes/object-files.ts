import { BatchSecondPersonCommandSchema, BatchTagsCommandSchema } from '../../commands/object-batch'
import {
  AssignLifeCommandSchema,
  BuildFypVersionsCommandSchema,
  DownloadFilesCommandSchema,
  ExtractShootCommandSchema,
  MakeCoverCommandSchema,
  MakeMasterCommandSchema,
  MakePhotosCommandSchema,
  MergeRawCommandSchema,
  PickFramesCommandSchema,
  RemoveFilesCommandSchema,
  ReorderFilesCommandSchema,
  SetRawPurposeCommandSchema,
} from '../../commands/object-files'
import { AcceptResultSchema } from '../../domain/inbox'
import { ItemDetailSchema } from '../../domain/item'
import { DownloadAnswerSchema, OperationAcceptedSchema } from '../../domain/operations'
import { BatchResultSchema } from '../../domain/pagination'
import { ItemCreatedSchema } from '../responses'
import { defineRoute } from '../route'

/**
 * Files inside one object (DESIGN §4.5): the answer is the object page again, so the
 * screen shows exactly what the server saved. Long builds answer 202 with an operation.
 */
export const objectFileRoutes = {
  reorder: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/files:reorder',
    body: ReorderFilesCommandSchema,
    response: ItemDetailSchema,
    versioned: true,
  }),
  pick: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/files:pick',
    body: PickFramesCommandSchema,
    response: ItemDetailSchema,
  }),
  assign: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/files:assign',
    body: AssignLifeCommandSchema,
    response: ItemDetailSchema,
  }),
  remove: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/files:remove',
    body: RemoveFilesCommandSchema,
    response: ItemDetailSchema,
    versioned: true,
  }),
  download: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/files:download',
    body: DownloadFilesCommandSchema,
    response: DownloadAnswerSchema,
  }),
  makePhotos: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/frames:make-photos',
    body: MakePhotosCommandSchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  makeCover: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:make-cover',
    body: MakeCoverCommandSchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  buildFypVersions: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}/fyp-versions',
    body: BuildFypVersionsCommandSchema,
    response: OperationAcceptedSchema,
    success: 202,
  }),
  setPurpose: defineRoute({
    method: 'PATCH',
    path: '/api/v1/{model}/i/{id}/purpose',
    body: SetRawPurposeCommandSchema,
    response: ItemDetailSchema,
    versioned: true,
  }),
  extractShoot: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:extract',
    body: ExtractShootCommandSchema,
    response: ItemCreatedSchema,
    success: 201,
  }),
  merge: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:merge',
    body: MergeRawCommandSchema,
    response: ItemCreatedSchema,
    versioned: true,
  }),
  makeMaster: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/i/{id}:make-master',
    body: MakeMasterCommandSchema,
    response: AcceptResultSchema,
    success: 201,
  }),
}

/** Several objects of the Library at once: «по каждой записи». */
export const objectBatchRoutes = {
  tags: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/items:tags',
    body: BatchTagsCommandSchema,
    response: BatchResultSchema,
  }),
  secondPerson: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/items:second-person',
    body: BatchSecondPersonCommandSchema,
    response: BatchResultSchema,
  }),
}
