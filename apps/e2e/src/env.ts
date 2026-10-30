/** Where the stack of the scenarios listens and who signs in (`stack.ts`, the specs). */
const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3100)
const webPort = Number(process.env.E2E_WEB_PORT ?? 4173)

export const E2E = {
  serverPort,
  webPort,
  /** The origin of the interface; `PUBLIC_URL` of the server is the same. */
  baseUrl: `http://127.0.0.1:${webPort}`,
  /** Password of the owner `dmitriy` and of the content manager `diana` (seed `--plan`). */
  password: 'contentops-e2e',
} as const
