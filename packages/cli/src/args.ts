/** A command the CLI cannot form a request from: exit code 64. */
export class UsageError extends Error {
  override name = 'UsageError'
}

/** Flags without a value; every other flag takes one (`--name value` or `--name=value`). */
const SWITCHES = new Set(['json', 'wait', 'help'])

export interface ParsedArgs {
  /** `objects get`, `objects.get`, `routes`, `help`. */
  words: string[]
  /** Every `--name value` in order; a flag may repeat. */
  flags: Map<string, string[]>
  json: boolean
  wait: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = []
  const flags = new Map<string, string[]>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string
    if (token === '-h') {
      switches.add('help')
      continue
    }
    if (!token.startsWith('--')) {
      words.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    if (!name) throw new UsageError(`bad flag ${token}`)
    if (SWITCHES.has(name)) {
      if (equals !== -1) throw new UsageError(`--${name} takes no value`)
      switches.add(name)
      continue
    }
    let value: string
    if (equals !== -1) value = token.slice(equals + 1)
    else {
      // A value that starts with `--` goes as `--name=--value`: here it is a forgotten value.
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--'))
        throw new UsageError(`--${name} needs a value`)
      value = next
      index++
    }
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  return {
    words,
    flags,
    json: switches.has('json'),
    wait: switches.has('wait'),
    help: switches.has('help'),
  }
}

/** Removes a flag that may be given once and returns its value. */
export function takeOne(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name)
  if (!values) return undefined
  flags.delete(name)
  if (values.length > 1) throw new UsageError(`--${name} is given more than once`)
  return values[0]
}
