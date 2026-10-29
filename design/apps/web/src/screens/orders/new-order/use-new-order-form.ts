import { type Model, type OrderFields, OrderFieldsSchema } from '@contentops/contracts'
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useOrderCardParse } from '@/data/orders'
import { useDebouncedValue } from './use-debounced-value'

const PARSE_DELAY_MS = 250

function emptyFields(model: Model): OrderFields {
  return {
    title: '',
    buyer: null,
    account: model.accounts[0]?.code ?? '',
    brief: null,
    duration_raw: '',
    wants_video: true,
    wants_photos: 0,
    deadline: null,
    fan_name: 'unknown',
    message_url: null,
    card_text: null,
  }
}

/**
 * Форма «Нового заказа» (DESIGN §4.16): вставили текст карточки — поля разобраны.
 * Поле, которое человек уже поправил руками, новый разбор не перетирает (§3.13, п. 5):
 * разбор ложится как новые исходные значения, а правленые поля остаются правлеными.
 */
export function useNewOrderForm(model: Model) {
  const form = useForm<OrderFields>({
    resolver: zodResolver(OrderFieldsSchema),
    defaultValues: emptyFields(model),
  })
  const [cardText, messageUrl] = useWatch({
    control: form.control,
    name: ['card_text', 'message_url'],
  })
  const settledText = useDebouncedValue(cardText ?? '', PARSE_DELAY_MS)
  const parsed = useOrderCardParse(model.code, settledText, messageUrl)
  const accounts = model.accounts

  useEffect(() => {
    const fields = parsed.data
    if (!fields) return
    const knownAccount = accounts.some((account) => account.code === fields.account)
    form.reset(
      {
        ...fields,
        account: knownAccount ? fields.account : form.getValues('account'),
        card_text: form.getValues('card_text'),
        message_url: form.getValues('message_url'),
      },
      {
        keepDirtyValues: true,
        keepErrors: true,
        keepTouched: true,
        keepIsSubmitted: true,
        keepSubmitCount: true,
      },
    )
  }, [parsed.data, form, accounts])

  return { form, parsed: parsed.data !== undefined }
}
