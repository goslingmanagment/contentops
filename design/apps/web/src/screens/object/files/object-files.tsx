import type { ItemType } from '@contentops/contracts'
import type { ComponentType } from 'react'
import { useObjectPage } from '../object-context'
import { CustomFiles } from './types/custom-files'
import { FypFiles } from './types/fyp-files'
import { LifeFiles } from './types/life-files'
import { PpvFiles } from './types/ppv-files'
import { PromoFiles } from './types/promo-files'
import { RawFiles } from './types/raw-files'
import { SetFiles } from './types/set-files'
import { SextingFiles } from './types/sexting-files'

/** Файлы по ролям — у каждого типа свои разделы (DESIGN §4.5). */
const FILES_BY_TYPE: Record<ItemType, ComponentType> = {
  ppv: PpvFiles,
  custom: CustomFiles,
  set: SetFiles,
  sexting: SextingFiles,
  fyp: FypFiles,
  life: LifeFiles,
  raw: RawFiles,
  promo: PromoFiles,
}

/** Файлы объекта сразу под строкой «где залито», на первом экране. */
export function ObjectFiles() {
  const { detail } = useObjectPage()
  const Files = FILES_BY_TYPE[detail.entry.type]
  return <Files />
}
