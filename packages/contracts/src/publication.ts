import type { PlacementVerdict } from './domain/placement'
import type { PublicationCheck, PublicationKind, PublicationState } from './domain/plan'

/**
 * Words of a publication through Hub (SPEC §7 «Публикация через Hub», DESIGN §4.11, §5.2): the
 * state the row shows, Hub's checks and reasons in Russian, and the verdict of a row whose
 * publication has gone to Hub — the link row → publication → post is exact, so the waiting and
 * «не вышло» rules of matching do not apply to it.
 */

export const PUBLICATION_KIND_LABEL: Record<PublicationKind, string> = {
  fyp_post: 'пост в фуп',
  subscriber_post: 'пост на стену',
  paid_post: 'пост на стену с ценой',
  story: 'сториз',
  vault_album: 'альбом vault',
}

export const PUBLICATION_STATE_WORD: Record<PublicationState, string> = {
  draft: 'черновик в Hub',
  sent: 'отправлено',
  scheduled: 'в расписании',
  published: 'вышло',
  not_published: 'не вышло',
  unverified: 'не удалось проверить',
  cancelled: 'публикация отменена',
}

/** Hub's checks of a draft (`findings[].code`) in words; an unknown one keeps its code. */
const FINDING_TEXT: Record<string, string> = {
  price_range_not_set:
    'Hub: вилка цен страницы не задана — пост с ценой ждёт, пока её задаст владелец',
  price_out_of_range: 'Hub: цена вне вилки цен страницы',
  publish_time_past: 'Hub: время выхода уже прошло — перенесите строку',
  media_not_on_page: 'Hub: этого файла нет в vault страницы',
  file_of_another_model: 'Hub: файл другой модели',
  file_bytes_deleted: 'Hub: файл удалён из хранилища Hub — подготовьте заново',
  duplicate_media: 'Hub: этот файл уже выходил на странице',
  recent_repost: 'Hub: этот файл недавно выходил на странице',
  caption_too_long: 'Hub: подпись длиннее, чем разрешает площадка',
  tier_unknown: 'Hub: такого тира у страницы нет',
  wall_unknown: 'Hub: такой стены у страницы нет',
}

export function findingText(code: string): string {
  return FINDING_TEXT[code] ?? `Hub: ${code.replaceAll('_', ' ')}`
}

export function publicationCheck(finding: { code: string; severity: string }): PublicationCheck {
  const severity =
    finding.severity === 'blocking' || finding.severity === 'warning' ? finding.severity : 'info'
  return { code: finding.code, severity, text: findingText(finding.code) }
}

/** Why it did not go out (`statusReason` of Hub), in words. */
const REASON_TEXT: Record<string, string> = {
  upload_failed: 'файл не загрузился',
  media_rejected: 'площадка не приняла файл',
  platform_rejected: 'площадка отклонила пост',
  missed: 'время выхода прошло, площадка не опубликовала',
  withdrawn: 'снята владельцем в Hub',
  rejected: 'отклонена в Hub',
  answer_lost: 'ответ площадки потерян',
  session_expired: 'вход в аккаунт площадки истёк',
}

export function publicationReasonText(status: string, reason: string | null): string {
  const key = reason ?? (status === 'not_published' ? null : status)
  if (key === null) return 'Hub не назвал причину'
  return REASON_TEXT[key] ?? key.replaceAll('_', ' ')
}

/** The verdict of a row whose publication went to Hub; `null` — the row's own verdict stands. */
export function publicationVerdict(
  base: PlacementVerdict,
  publication: { state: PublicationState; text: string; date: string | null },
): PlacementVerdict | null {
  const keep = { notes: base.notes, facts: { ...base.facts, hub: publication.text } }
  const date = publication.date ?? base.date
  switch (publication.state) {
    case 'sent':
      return {
        ...keep,
        level: 'scheduled',
        sign: null,
        word: PUBLICATION_STATE_WORD.sent,
        detail: null,
        reason: publication.text,
        date,
      }
    case 'scheduled':
      return {
        ...keep,
        level: 'scheduled',
        sign: null,
        word: PUBLICATION_STATE_WORD.scheduled,
        detail: null,
        reason: publication.text,
        date,
      }
    case 'published':
      return {
        ...keep,
        level: 'confirmed_exact',
        sign: 'done',
        word: PUBLICATION_STATE_WORD.published,
        detail: 'Hub',
        reason: publication.text,
        date,
      }
    case 'not_published':
      return {
        ...keep,
        level: 'not_published',
        sign: 'trouble',
        word: PUBLICATION_STATE_WORD.not_published,
        detail: publication.text.replace(/^Hub: /, ''),
        reason: publication.text,
        date,
      }
    case 'unverified':
      return {
        ...keep,
        level: 'cannot_verify',
        sign: null,
        word: PUBLICATION_STATE_WORD.unverified,
        detail: 'решает владелец в Hub',
        reason: publication.text,
        date,
      }
    default:
      return null
  }
}
