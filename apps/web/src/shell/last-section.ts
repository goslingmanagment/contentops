import { z } from 'zod'
import { readStored, writeStored } from '@/lib/browser-storage'

/**
 * Вход в раздел, где человек был в прошлый раз (DESIGN §2.3): Диана утром окажется в
 * Плане, владелец — в Библиотеке. Первый вход — Библиотека.
 */
const LAST_SECTION_KEY = 'contentops:last-section'

export const SectionKeySchema = z.enum(['inbox', 'library', 'plan', 'journal'])
export type SectionKey = z.infer<typeof SectionKeySchema>

const LastSectionSchema = z.object({ model: z.string(), section: SectionKeySchema })
export type LastSection = z.infer<typeof LastSectionSchema>

export function readLastSection(): LastSection | null {
  const raw = readStored('session', LAST_SECTION_KEY)
  if (!raw) {
    return null
  }
  try {
    return LastSectionSchema.safeParse(JSON.parse(raw)).data ?? null
  } catch {
    return null
  }
}

export function rememberSection(value: LastSection): void {
  writeStored('session', LAST_SECTION_KEY, JSON.stringify(value))
}
