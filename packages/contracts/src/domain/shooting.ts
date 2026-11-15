import { z } from 'zod'
import { ActorRefSchema, InstantSchema, LocalDateSchema } from './common'

/**
 * «Съёмка › ТЗ» (products plan 15.11.2026 §2.4, package C3): a task for the model that is not a
 * fan's order — a set, a batch of FYP — with a deadline and a hand-in. Kept in ContentOps; a fan's
 * custom order is Agency Hub's (the tab «Кастомы» reads it).
 */
export const ShootingTaskKindSchema = z.enum(['set', 'fyp', 'other'])
export type ShootingTaskKind = z.infer<typeof ShootingTaskKindSchema>

export const SHOOTING_TASK_KIND_LABEL: Record<ShootingTaskKind, string> = {
  set: 'Сет',
  fyp: 'FYP',
  other: 'Другое',
}

export const ShootingTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: ShootingTaskKindSchema,
  note: z.string().nullable(),
  deadline: LocalDateSchema.nullable(),
  /** Days past the deadline while not handed in; `null` — not overdue. */
  overdue_days: z.int().positive().nullable(),
  created_at: InstantSchema,
  created_by: ActorRefSchema,
  handed_in: z.object({ at: InstantSchema, by: ActorRefSchema }).nullable(),
})
export type ShootingTask = z.infer<typeof ShootingTaskSchema>

export const ShootingTaskListSchema = z.object({
  /** Waited for, the nearest deadline first. */
  open: z.array(ShootingTaskSchema),
  /** Handed in within 14 days, the newest first. */
  done: z.array(ShootingTaskSchema),
})
export type ShootingTaskList = z.infer<typeof ShootingTaskListSchema>

export const CreateShootingTaskCommandSchema = z.object({
  title: z.string().trim().min(1, 'Нужно название').max(200),
  kind: ShootingTaskKindSchema,
  note: z.string().trim().max(2000).nullable().optional(),
  deadline: LocalDateSchema.nullable().optional(),
})
export type CreateShootingTaskCommand = z.infer<typeof CreateShootingTaskCommandSchema>
