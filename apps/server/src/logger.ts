import { type DestinationStream, type Logger, pino } from 'pino'

/** Secrets never reach the log, whatever object a line carries. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'password',
  '*.password',
  '*.temporary_password',
]

export interface LoggerOptions {
  level?: string
  role?: string
  /** stdout when absent; tests pass a memory stream. */
  stream?: DestinationStream
}

/** pino JSON lines to stdout, time in UTC ISO (SPEC §12.0, §12.1). */
export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: options.role ? { role: options.role } : null,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    options.stream ?? pino.destination(1),
  )
}
