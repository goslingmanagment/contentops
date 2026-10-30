/** Everything the CLI touches outside itself; tests pass fakes. */
export interface Io {
  env: Record<string, string | undefined>
  fetch: (url: string, init: RequestInit) => Promise<Response>
  stdout(text: string): void
  stderr(text: string): void
  readStdin(): Promise<string>
  /** Directory that `--body @file` and `--out` are relative to. */
  cwd: string
  sleep(ms: number): Promise<void>
  now(): number
}

export function processIo(): Io {
  return {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString('utf8')
    },
    // `pnpm contentops` runs in the repo root; INIT_CWD is where it was typed.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}
