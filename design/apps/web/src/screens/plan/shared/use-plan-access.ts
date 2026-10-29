import type { Role } from '@contentops/contracts'
import { useSession } from '@/data/session'

export interface PlanAccess {
  role: Role | null
  /** Ставить, отмечать, отменять и скачивать: КМ и владелец (DESIGN §2.3). */
  canAct: boolean
  /** Кто вошёл: чип «Мои» — фильтр по тому, кто выкладывает. */
  personId: string | null
}

/** Что вошедший может делать в Плане. Пока сеанс не пришёл, действий нет. */
export function usePlanAccess(): PlanAccess {
  const person = useSession().data?.person ?? null
  const role = person?.role ?? null
  return {
    role,
    canAct: role === 'owner' || role === 'manager',
    personId: person?.id ?? null,
  }
}
