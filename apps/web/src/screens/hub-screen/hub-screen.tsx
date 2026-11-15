import { Button } from '@contentops/ui/components/button'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '@/data/session'
import { FieldMessage } from '@/shell/field/field-message'
import { useCurrentModel } from '@/shell/model/model-context'
import { type HubScreenSearch, innerQuery, routerSearch, sameQuery } from './search'

/**
 * «Публикации» and «Статистика» (products plan §2.4, package C2): the menu item, the address and the
 * frame are ContentOps'; the screen is Hub's own page without Hub's frame
 * (`<Hub>/frame/publications`, `/frame/content-stats`), on the whole working area. The person acts in
 * it with their own Hub session and rights (a content manager — the pages of their models). Hub's page
 * says where it is (its query: mirrored here, so «Назад», a reload and a link keep the place) and that
 * nobody is signed in to Hub in this browser (then «Войдите через Hub», never a broken frame). Opened
 * by password or on the VPN address, there is no Hub session to show it with: the same «Войдите через
 * Hub» at once.
 */
export type HubScreenId = 'publications' | 'stats'

const PATH: Record<HubScreenId, string> = {
  publications: '/frame/publications',
  stats: '/frame/content-stats',
}

const TITLE: Record<HubScreenId, string> = { publications: 'Публикации', stats: 'Статистика' }

/** What Hub's page says to its frame (apps/dashboard/src/frame/ContentScreen.tsx in Hub). */
type HubMessage =
  | { source: 'hub-content-screen'; type: 'location'; search: string }
  | { source: 'hub-content-screen'; type: 'signed-out' }

function isHubMessage(data: unknown): data is HubMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === 'hub-content-screen'
  )
}

export function HubScreen({ screen, search }: { screen: HubScreenId; search: HubScreenSearch }) {
  const model = useCurrentModel()
  const session = useSession()
  const hub = session.data?.hub_screens
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [signedOut, setSignedOut] = useState(false)

  const wanted = useMemo(() => innerQuery(search), [search])
  /** The query Hub's page said last: a change of ours that equals it is the mirror, not a new place. */
  const said = useRef<URLSearchParams | null>(null)
  /** The frame's address: set when the screen opens and when ContentOps' own address leads elsewhere. */
  const [src, setSrc] = useState<string | null>(null)

  const hubSlug = hub?.models[model.code] ?? model.code
  useEffect(() => {
    if (!hub?.framed) return
    if (said.current !== null && sameQuery(said.current, wanted)) return
    const query = new URLSearchParams(wanted)
    query.set('model', hubSlug)
    said.current = new URLSearchParams(wanted)
    setSrc(`${hub.origin}${PATH[screen]}?${query.toString()}`)
  }, [hub, hubSlug, screen, wanted])

  useEffect(() => {
    if (!hub?.framed) return
    function onMessage(event: MessageEvent) {
      if (
        event.origin !== hub?.origin ||
        event.source !== frameRef.current?.contentWindow ||
        !isHubMessage(event.data)
      )
        return
      if (event.data.type === 'signed-out') {
        setSignedOut(true)
        return
      }
      const query = new URLSearchParams(event.data.search)
      query.delete('model')
      said.current = query
      // The place is mirrored into ContentOps' address in place: the frame's own steps are the history.
      void navigate({
        to: pathname,
        search: routerSearch(query) as never,
        replace: true,
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [hub, navigate, pathname])

  if (session.isPending) return null
  if (!hub) {
    return (
      <FieldMessage>
        <h1 className="font-medium text-lg">{TITLE[screen]}</h1>
        <p className="text-muted-foreground text-sm">
          Этот экран открывается через Hub. Попросите владельца.
        </p>
      </FieldMessage>
    )
  }
  if (!hub.framed || signedOut) {
    const next = `${pathname}${wanted.size > 0 ? `?${wanted.toString()}` : ''}`
    return (
      <FieldMessage>
        <h1 className="font-medium text-lg">Войдите через Hub</h1>
        <p className="max-w-md text-muted-foreground text-sm">
          {TITLE[screen]} показывает Hub, и для этого нужен ваш вход в Hub в этом браузере.
        </p>
        <Button asChild>
          <a href={`${hub.signin}?${new URLSearchParams({ next }).toString()}`}>Войти через Hub</a>
        </Button>
      </FieldMessage>
    )
  }
  return src === null ? null : (
    <iframe
      ref={frameRef}
      key={`${screen}:${hubSlug}`}
      src={src}
      title={TITLE[screen]}
      className="block h-full w-full border-0"
    />
  )
}
