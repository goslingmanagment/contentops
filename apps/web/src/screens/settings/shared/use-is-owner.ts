import { useRole } from '@/data/session'

/** Интеграции, пороги, люди и ИИ меняет только владелец (§4.19); остальные видят и читают. */
export function useIsOwner(): boolean {
  return useRole() === 'owner'
}
