// Named import: works for pino's CommonJS build under both ESM and TypeScript NodeNext resolution.
import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { app: 'smart-autopilot' },
    redact: {
      paths: [
        'apiKey',
        'password',
        'token',
        'openSubtitlesApiKey',
        '*.openSubtitlesApiKey',
        'config',
        'headers.Api-Key',
        'headers.Authorization',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
  });
}

/** Logger that discards everything; handy for tests. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
