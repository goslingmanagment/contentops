import { type CheckCase, formatNumber } from '@contentops/contracts'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@contentops/ui/components/collapsible'
import { ChevronRightIcon } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-ink-3 text-sm">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  )
}

/** Части имени с «_» на конце: перенос строки встаёт после подчёркивания, а не посреди слова. */
function nameParts(name: string): { at: number; text: string }[] {
  const parts: { at: number; text: string }[] = []
  let at = 0
  for (const text of name.split(/(?<=_)/)) {
    parts.push({ at, text })
    at += text.length
  }
  return parts
}

/** Выданное имя целиком, моноширинным: переносится по «_», ширину панели не распирает. */
function IssuedName({ name }: { name: string }) {
  return (
    <span title={name} className="font-mono text-xs wrap-anywhere">
      {nameParts(name).map((part) => (
        <Fragment key={part.at}>
          {part.text}
          <wbr />
        </Fragment>
      ))}
    </span>
  )
}

/**
 * Свёрнутое «Подробнее» (DESIGN §4.15): выданное имя моноширинным и кому выдано, имя файла
 * на платформе, размеры, подпись с платформы и «Как проверяли · 3». На виду в панели только
 * миниатюра, одна фраза, ссылка на пост и кнопки. Пустое не пишется.
 */
export function PairDetails({ entry }: { entry: CheckCase }) {
  const { details } = entry
  const post = entry.posts.length === 1 ? entry.posts[0] : undefined
  // У поста без плана подпись уже стоит на его стороне пары.
  const caption = entry.kind === 'unplanned' ? null : post?.caption
  return (
    <Collapsible className="flex flex-col gap-3">
      <CollapsibleTrigger className="group inline-flex items-center gap-1 self-start rounded-sm text-muted-foreground text-sm hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-4 transition-transform duration-120 group-data-[state=open]:rotate-90"
        />
        Подробнее
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="flex flex-col gap-3">
          {details.issued_name ? (
            <Fact label={details.issued_to ? `Выдано · ${details.issued_to}` : 'Выдано'}>
              <IssuedName name={details.issued_name} />
            </Fact>
          ) : null}
          {post?.platform_file_name ? (
            <Fact label="Файл на платформе">
              <span className="break-all font-mono text-xs">{post.platform_file_name}</span>
            </Fact>
          ) : null}
          {details.sizes ? <Fact label="Размеры">{details.sizes}</Fact> : null}
          {caption ? <Fact label="Подпись с платформы">«{caption}»</Fact> : null}
          <Fact label={`Как проверяли · ${formatNumber(details.how_checked.length)}`}>
            <ul className="flex flex-col gap-1">
              {details.how_checked.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Fact>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
