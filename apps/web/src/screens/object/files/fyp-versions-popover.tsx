import {
  type BuildFypVersionsCommand,
  BuildFypVersionsCommandSchema,
  type ItemDetail,
  type Model,
  UNIQ_LEVEL_LABEL,
  type UniqLevel,
  UniqLevelSchema,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { zodResolver } from '@hookform/resolvers/zod'
import { LayersIcon } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useObjectPage } from '../object-context'
import { useBuildFypVersions } from './use-file-commands'

const COUNTS = ['1', '2', '3', '4', '5'] as const

/**
 * По умолчанию — столько версий, сколько страниц Fansly ещё без своей версии, и уровень,
 * какой стоит у этих страниц (DESIGN §4.5).
 */
function defaults(detail: ItemDetail, model: Model): BuildFypVersionsCommand {
  const pages = model.accounts.filter(
    (account) =>
      account.platform === 'fansly' &&
      !detail.pages.some((page) => page.account === account.code && page.summary.has_fyp_version),
  )
  const levels = pages.map((account) => account.uniq_level)
  const level = UniqLevelSchema.options.find((option) => levels.includes(option)) ?? 'soft'
  return { count: Math.min(5, Math.max(1, pages.length)), level }
}

/** «Собрать версии» фупа — всплывашка 320 (DESIGN §3.9): сколько и насколько менять. */
export function FypVersionsPopover() {
  const { detail, model } = useObjectPage()
  const build = useBuildFypVersions()
  const [open, setOpen] = useState(false)
  const form = useForm<BuildFypVersionsCommand>({
    resolver: zodResolver(BuildFypVersionsCommandSchema),
    defaultValues: defaults(detail, model),
  })
  const submit = form.handleSubmit((command) => {
    build(command)
    setOpen(false)
  })

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          form.reset(defaults(detail, model))
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <LayersIcon />
          Собрать версии
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-ink-3 text-sm">Сколько</h3>
            <Controller
              control={form.control}
              name="count"
              render={({ field }) => (
                <ChoiceChips
                  label="Сколько версий"
                  choices={COUNTS.map((count) => ({ value: count, label: count }))}
                  value={String(field.value)}
                  onChange={(value) => field.onChange(Number(value))}
                />
              )}
            />
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-ink-3 text-sm">Насколько менять</h3>
            <Controller
              control={form.control}
              name="level"
              render={({ field }) => (
                <ChoiceChips<UniqLevel>
                  label="Насколько менять"
                  choices={UniqLevelSchema.options.map((level) => ({
                    value: level,
                    label: UNIQ_LEVEL_LABEL[level],
                  }))}
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          </section>
          <Button type="submit" className="self-start">
            Собрать
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
