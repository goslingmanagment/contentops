import {
  FAN_NAME_CHOICES,
  type InboxGroup,
  PPV_KIND_LABEL,
  PpvKindSchema,
  RAW_PURPOSE_LABEL,
  RawPurposeSchema,
} from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Switch } from '@contentops/ui/components/switch'
import { useId } from 'react'
import { ChoiceField } from './choice-field'
import { DraftTextField } from './draft-text-field'
import { FieldRow } from './field-row'
import { OrderLine } from './order-line'
import { PromoFields } from './promo-fields'
import { TagField } from './tag-field'
import { TypeButtons } from './type-buttons'
import type { DraftSave } from './use-draft-save'

const options = <Value extends string>(
  values: readonly Value[],
  labels: Record<Value, string>,
): { value: Value; label: string }[] => values.map((value) => ({ value, label: labels[value] }))

const PPV_KINDS = options(PpvKindSchema.options, PPV_KIND_LABEL)
const RAW_PURPOSES = options(RawPurposeSchema.options, RAW_PURPOSE_LABEL)

interface DraftFieldsProps {
  group: InboxGroup
  saver: DraftSave
}

/**
 * Поля черновика (DESIGN §4.8, п. 2): тип восемью кнопками, название, описание, теги,
 * поля по типу, «Второй человек в кадре», у кастома — имя фана и заказ. Правятся и пока
 * группа готовится. Откуда взялось значение — в подсказке у подписи.
 */
export function DraftFields({ group, saver }: DraftFieldsProps) {
  const fields = group.fields
  const secondId = useId()
  const whatIsIt = group.state.kind === 'decision' && group.state.decision === 'what_is_it'
  const ownUpload = group.uploaded_by !== null
  // Пока ◆ «Какой заказ?» не решён, заказа ещё нет, но и «без заказа» никто не выбирал.
  const whichOrder = group.state.kind === 'decision' && group.state.decision === 'which_order'
  return (
    <InfoSection title="Черновик">
      {whatIsIt ? null : (
        <FieldRow label="Тип" source={fields.type ? `из корня ${group.root}` : null}>
          <TypeButtons
            label="Тип"
            value={fields.type}
            onChange={(type) => void saver.save({ type })}
          />
        </FieldRow>
      )}
      <DraftTextField
        field="title"
        label="Название"
        value={fields.title}
        // Своя загрузка без цели приходит с пустыми полями (§4.8): имени группы
        // «Загружено вами · 3 фото» в поле не место даже подсказкой.
        source={ownUpload ? null : `из имени ${group.source_path}`}
        placeholder={ownUpload ? undefined : group.title}
        saver={saver}
      />
      <DraftTextField
        field="description"
        label="Описание"
        value={fields.description}
        multiline
        placeholder="Что в кадре"
        saver={saver}
      />
      <TagField tags={fields.tags} saver={saver} />
      {fields.type === 'ppv' ? (
        <ChoiceField
          label="Вид PPV"
          value={fields.ppv_kind}
          options={PPV_KINDS}
          onChange={(ppvKind) => void saver.save({ ppv_kind: ppvKind })}
        />
      ) : null}
      {fields.type === 'raw' ? (
        <ChoiceField
          label="Назначение съёмки"
          value={fields.raw_purpose}
          options={RAW_PURPOSES}
          onChange={(purpose) => void saver.save({ raw_purpose: purpose })}
        />
      ) : null}
      {fields.type === 'promo' ? <PromoFields group={group} saver={saver} /> : null}
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={secondId} className="text-base">
          Второй человек в кадре
        </label>
        <Switch
          id={secondId}
          checked={fields.second_person}
          onCheckedChange={(checked) => void saver.save({ second_person: checked })}
        />
      </div>
      {fields.type === 'custom' ? (
        <>
          <ChoiceField
            label="Имя фана в ролике"
            value={fields.fan_name}
            options={FAN_NAME_CHOICES}
            onChange={(fanName) => void saver.save({ fan_name: fanName })}
          />
          <FieldRow label="Заказ">
            {fields.order_id ? (
              <OrderLine orderId={fields.order_id} />
            ) : (
              <span className="text-muted-foreground">
                {whichOrder ? 'не выбран' : 'без заказа'}
              </span>
            )}
          </FieldRow>
        </>
      ) : null}
    </InfoSection>
  )
}
