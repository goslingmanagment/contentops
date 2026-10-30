import { pastVerb } from '@contentops/contracts/format'
import type { MockState } from '../state'

/** «Диана отметила», «Никита поставил»: the subject and the verb of a journal phrase. */
export function actorSays(state: MockState, masculineVerb: string): string {
  return `${state.principal.name} ${pastVerb(masculineVerb, state.principal.gender)}`
}
