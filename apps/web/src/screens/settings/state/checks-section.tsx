import { formatNumber, plural, type SystemState } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { useNavigate } from '@tanstack/react-router'
import { useIsOwner } from '../shared/use-is-owner'

function hoursWord(hours: number): string {
  return `${formatNumber(hours)} ч`
}

/**
 * Задержка Hub, находки проверки хранилища, расход на ИИ и межмодельные дубли. Строки
 * ИИ и дублей появляются, только когда им есть что сказать (§4.19, §4.20).
 */
export function ChecksSection({ state }: { state: SystemState }) {
  const owner = useIsOwner()
  const navigate = useNavigate()
  const latency = state.hub_latency
  const findings = state.storage_findings
  const duplicates = state.cross_model_duplicates

  return (
    <SettingsSection title="Проверки">
      {latency ? (
        <SettingsRow
          label="Hub"
          detail={`обычно видит пост за ${hoursWord(latency.typical_hours)}, бывает до ${hoursWord(latency.max_hours)}`}
        >
          {latency.warning ? (
            <span className="inline-flex items-center gap-2 text-attention-ink text-sm">
              <StatusSign kind="turn" />
              {latency.warning}
              {owner ? (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() =>
                    void navigate({ to: '/settings/$tab', params: { tab: 'thresholds' } })
                  }
                >
                  Пороги
                </Button>
              ) : null}
            </span>
          ) : null}
        </SettingsRow>
      ) : null}
      <SettingsRow
        label="Проверка хранилища"
        detail={findings.length > 0 ? findings.join(' · ') : undefined}
      >
        <span className="text-muted-foreground">
          {findings.length > 0
            ? `${formatNumber(findings.length)} ${plural(findings.length, ['находка', 'находки', 'находок'])}`
            : 'находок нет'}
        </span>
      </SettingsRow>
      {state.ai_spend ? (
        <SettingsRow label="Расход на ИИ">
          <span className="text-muted-foreground tabular-nums">{state.ai_spend}</span>
        </SettingsRow>
      ) : null}
      {duplicates !== null ? (
        <SettingsRow label="Межмодельные дубли" detail="один и тот же файл у двух моделей">
          <span className="text-muted-foreground tabular-nums">
            {duplicates === 0
              ? 'нет'
              : `${formatNumber(duplicates)} ${plural(duplicates, ['объект', 'объекта', 'объектов'])}`}
          </span>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  )
}
