import { type CatalogEntry, ITEM_TYPE_INFO } from '@contentops/contracts'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@contentops/ui/components/breadcrumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useSectionHref } from './section-href'

/** «Библиотека › PPV › PPV-073» (DESIGN §4.4): раздел — ссылка, объект — текущая страница. */
export function ObjectCrumbs({ entry }: { entry: Pick<CatalogEntry, 'id' | 'type'> }) {
  const hrefs = useSectionHref()
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <UiLink href={hrefs.library}>Библиотека</UiLink>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <UiLink href={hrefs.section(entry.type)}>{ITEM_TYPE_INFO[entry.type].folder}</UiLink>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="tabular-nums">{entry.id}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
