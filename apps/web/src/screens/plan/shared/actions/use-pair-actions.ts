import type { CheckCase } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { useCurrentModel } from '@/shell/model/model-context'

function pairName(checkCase: CheckCase): string {
  return checkCase.version_label ?? checkCase.item_id ?? checkCase.title
}

/**
 * «Это оно» и «Не то» у ◆ строки плана (DESIGN §4.11: пара открывается в панели справа).
 * Та же команда, что во вкладке «Сверить»; отмена подтверждения — из полоски.
 */
export function usePairActions() {
  const model = useCurrentModel().code
  const commands = usePlanCommands(model)
  const toast = useActionToast()
  const invalidates = () => planChangedKeys(model)

  const undo = useIntentMutation<{ checkCase: CheckCase }, unknown>({
    failed: 'Не отменилось',
    run: ({ checkCase }, key) => commands.undoPair({ key, checkCase: checkCase.id }),
    invalidates,
    onSuccess: () => toast.show({ message: 'Подтверждение отменено' }),
  })

  const confirm = useIntentMutation<{ checkCase: CheckCase }, unknown>({
    failed: 'Не подтвердилось',
    run: ({ checkCase }, key) => commands.confirmPair({ key, checkCase: checkCase.id }),
    invalidates,
    onSuccess: (_, { checkCase }) =>
      toast.show({
        message: `Подтверждено · ${pairName(checkCase)}`,
        undoable: true,
        action: { label: 'Отменить', onSelect: () => undo.start({ checkCase }) },
      }),
  })

  const reject = useIntentMutation<{ checkCase: CheckCase }, unknown>({
    failed: 'Не записалось',
    run: ({ checkCase }, key) => commands.rejectPair({ key, checkCase: checkCase.id }),
    invalidates,
    onSuccess: () => toast.show({ message: 'Не то · пара снята' }),
  })

  return {
    confirm: (checkCase: CheckCase) => confirm.start({ checkCase }),
    reject: (checkCase: CheckCase) => reject.start({ checkCase }),
    pending: confirm.isPending || reject.isPending,
  }
}
