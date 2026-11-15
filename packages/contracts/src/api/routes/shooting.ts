import {
  CreateShootingTaskCommandSchema,
  ShootingTaskListSchema,
  ShootingTaskSchema,
} from '../../domain/shooting'
import { defineRoute } from '../route'

/** «Съёмка › ТЗ» (package C3): the model's tasks that are not a fan's order. */
export const shootingTaskRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/shooting-tasks',
    response: ShootingTaskListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/shooting-tasks',
    body: CreateShootingTaskCommandSchema,
    response: ShootingTaskSchema,
    success: 201,
  }),
  /** «Сдано»: the model handed it in. */
  handIn: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/shooting-tasks/{task}:hand-in',
    response: ShootingTaskSchema,
  }),
  /** «Убрать»: dropped; it stays in the journal. */
  cancel: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/shooting-tasks/{task}:cancel',
    response: ShootingTaskSchema,
  }),
}
