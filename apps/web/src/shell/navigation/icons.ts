import type { ItemType } from '@contentops/contracts'
import {
  ApertureIcon,
  CalendarDaysIcon,
  ClapperboardIcon,
  FolderIcon,
  FolderUpIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  ImagesIcon,
  InboxIcon,
  type LucideIcon,
  MegaphoneIcon,
  MessageCircleHeartIcon,
  PackageOpenIcon,
  SquarePlayIcon,
  SunIcon,
} from 'lucide-react'
import type { Destination } from './destinations'

/** Значки типов (DESIGN §7.7). */
export const ITEM_TYPE_ICON: Record<ItemType, LucideIcon> = {
  ppv: ClapperboardIcon,
  fyp: SquarePlayIcon,
  custom: PackageOpenIcon,
  set: ImagesIcon,
  sexting: MessageCircleHeartIcon,
  life: SunIcon,
  raw: ApertureIcon,
  promo: MegaphoneIcon,
}

const SECTION_ICON = {
  inbox: InboxIcon,
  library: FolderIcon,
  plan: CalendarDaysIcon,
  journal: HistoryIcon,
} as const

export function destinationIcon(destination: Destination): LucideIcon {
  switch (destination.kind) {
    case 'section':
      return SECTION_ICON[destination.section]
    case 'check':
      return GitCompareArrowsIcon
    case 'orders':
      return PackageOpenIcon
    case 'folder':
      return ITEM_TYPE_ICON[destination.type]
    case 'not-uploaded':
      return FolderUpIcon
  }
}
