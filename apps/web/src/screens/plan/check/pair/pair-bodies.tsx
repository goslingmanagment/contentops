import { Button } from '@contentops/ui/components/button'
import { PanelMain } from '@contentops/ui/components/panel-pin'
import { postMoment } from '../case-text'
import { AlbumSide } from './album-side'
import { AttachmentGrid } from './attachment-grid'
import type { CaseBodyProps } from './case-body'
import { PairDecision } from './pair-decision'
import { MatchPhrase, PairPhrase } from './pair-phrase'
import { OurComposition, OurSide, OurThumb, PairSides, PostLink } from './pair-sides'
import { VariantList } from './variant-list'

/**
 * Тела панели по виду случая (DESIGN §4.15). У каждого вверху пара — наше и платформа,
 * ниже решение; главная кнопка — в верхней трети панели. Выданное имя, подпись и размеры —
 * в «Подробнее».
 */

type PairProps = Pick<CaseBodyProps, 'entry' | 'account' | 'ours'>

/**
 * Одна пара с постом: наша миниатюра, рядом одна фраза «Пост 03:06 (+6 мин) · видео 0:09 —
 * совпадает» и «Пост на Fansly 2 ↗». Длительность называется только во фразе.
 */
function PostPair({ entry, account }: PairProps) {
  const post = entry.posts[0]
  if (!entry.item_id || !post) {
    return null
  }
  return (
    <div className="flex items-start gap-4">
      <OurThumb itemId={entry.item_id} />
      <div className="flex min-w-0 flex-col gap-2">
        {entry.pair_phrase ? (
          <PairPhrase entry={entry} />
        ) : (
          <MatchPhrase text={`${postMoment(post)} · ${post.summary}`} matches={null} />
        )}
        <PostLink url={post.url} pageLabel={account.label} />
      </div>
    </div>
  )
}

/** vault и «k из n»: наше рядом с альбомом и тем, что нашёл в нём обход Hub. */
function AlbumPair({ entry, account, ours }: PairProps) {
  if (!entry.item_id || !entry.album) {
    return null
  }
  // У «совпало k из n» чего нет, видно ниже по вложениям; повторять это справа незачем.
  const fact = entry.kind === 'partial' ? null : entry.verdict.reason
  return (
    <PairSides
      pageLabel={account.label}
      ours={<OurSide itemId={entry.item_id} entry={ours} />}
      theirs={<AlbumSide album={entry.album} fact={fact} />}
    />
  )
}

function Pair(props: PairProps) {
  return props.entry.posts[0] ? <PostPair {...props} /> : <AlbumPair {...props} />
}

/** Одна пара, «k из n», «стена или фуп?», расхождение: «Это оно» / «Не то». */
export function PairBody(props: CaseBodyProps) {
  const { entry, canDecide, pending, onDecide } = props
  return (
    <>
      <Pair {...props} />
      {canDecide ? (
        <PanelMain>
          <PairDecision entry={entry} pending={pending} onDecide={onDecide} />
        </PanelMain>
      ) : null}
      {entry.hint ? <p className="text-ink-3 text-sm">{entry.hint}</p> : null}
      {entry.item_id && entry.attachments.length > 0 ? (
        <AttachmentGrid itemId={entry.item_id} attachments={entry.attachments} />
      ) : null}
    </>
  )
}

/**
 * Несколько вариантов: наше сверху — миниатюра и состав, у сета с числом отобранных
 * кадров; посты карточками по времени, у каждой состав против нашего.
 */
export function VariantsBody({
  entry,
  account,
  ours,
  canDecide,
  pending,
  onDecide,
}: CaseBodyProps) {
  return (
    <>
      {entry.item_id ? (
        <section aria-label="Наше" className="flex items-start gap-4">
          <OurThumb itemId={entry.item_id} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-ink-3 text-sm">Наше</h3>
            {ours ? <OurComposition entry={ours} /> : null}
          </div>
        </section>
      ) : null}
      <VariantList
        entry={entry}
        ours={ours}
        pageLabel={account.label}
        canDecide={canDecide}
        pending={pending}
        onDecide={onDecide}
      />
    </>
  )
}

/**
 * vault: «в альбоме нет файла» или «старый файл в альбоме» → «Проверить заливку» (с лимитом
 * Hub) и «Залить заново» — окно «В план» для новой заливки.
 */
export function VaultBody(props: CaseBodyProps) {
  const { canDecide, pending, uploadCheck, onCheckUpload, onReupload } = props
  return (
    <>
      <Pair {...props} />
      {canDecide ? (
        <div className="flex flex-col gap-2">
          <PanelMain>
            {uploadCheck || !onCheckUpload ? null : (
              <Button
                pending={pending === 'check-upload'}
                disabled={pending !== null && pending !== 'check-upload'}
                onClick={onCheckUpload}
              >
                Проверить заливку
              </Button>
            )}
            <Button
              variant={onCheckUpload ? 'outline' : 'default'}
              disabled={pending !== null}
              onClick={onReupload}
            >
              Залить заново
            </Button>
          </PanelMain>
          {uploadCheck ? (
            <p className="text-base text-muted-foreground">{uploadCheck.text}</p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
