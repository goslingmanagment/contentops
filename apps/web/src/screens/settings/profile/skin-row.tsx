import { UI_SKIN_LABEL, type UiSkin, UiSkinSchema } from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { useId } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

const SKINS = UiSkinSchema.options.map((value) => ({ value, label: UI_SKIN_LABEL[value] }))

/** «Вид: синий / Фокус» (DESIGN §7.10): выбор хранится за человеком, по умолчанию синий. */
export function SkinRow({ skin }: { skin: UiSkin }) {
  const api = useApi()
  const toast = useActionToast()
  const labelId = useId()
  const save = useIntentMutation<UiSkin, unknown>({
    failed: 'Вид не сменился',
    run: (next, key) =>
      api.settings.updateProfile({ body: { ui_skin: next }, idempotencyKey: key }),
    invalidates: () => [queryKeys.session()],
    onSuccess: (_, next) => toast.show({ message: `Вид · ${UI_SKIN_LABEL[next]}` }),
  })

  return (
    <SettingsRow label={<span id={labelId}>Вид</span>}>
      <ChoiceChips
        labelledBy={labelId}
        choices={SKINS}
        value={skin}
        disabled={save.isPending}
        onChange={(next) => {
          if (next !== skin) save.start(next)
        }}
      />
    </SettingsRow>
  )
}
