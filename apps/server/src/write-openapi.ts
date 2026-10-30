import { writeFile } from 'node:fs/promises'
import { openApiDocument, openApiText } from './app'

/** Writes `apps/server/openapi.json` from the route table; a test keeps it in step. */
const target = new URL('../openapi.json', import.meta.url)
await writeFile(target, openApiText(await openApiDocument()))
process.stdout.write(`written ${target.pathname}\n`)
