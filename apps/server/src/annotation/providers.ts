import {
  createAnthropicProvider,
  createOpenAiProvider,
  type ProviderName,
  type VisionProvider,
} from '@contentops/vision'

/**
 * The adapters the worker can use: one per provider whose key is in the environment (SPEC §8:
 * secrets live there; the app starts without them). A provider without its key is «не
 * настроено»: its works wait with `annotation.key.<provider>` until a worker starts with it.
 */
export type ProviderRegistry = (name: ProviderName) => VisionProvider | null

export function envProviders(env: {
  OPENAI_API_KEY?: string | undefined
  ANTHROPIC_API_KEY?: string | undefined
}): ProviderRegistry {
  const openai = env.OPENAI_API_KEY ? createOpenAiProvider({ apiKey: env.OPENAI_API_KEY }) : null
  const anthropic = env.ANTHROPIC_API_KEY
    ? createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })
    : null
  return (name) => (name === 'openai' ? openai : anthropic)
}

/** Providers with a key in the environment of this process. */
export function configuredProviders(registry: ProviderRegistry): ProviderName[] {
  return (['openai', 'anthropic'] as const).filter((name) => registry(name) !== null)
}
