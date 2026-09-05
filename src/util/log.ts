export type LogLevel = 'silent' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { silent: 0, info: 1, debug: 2 };

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  readonly c: typeof C;
}

export function createLogger(level: LogLevel): Logger {
  const at = (want: LogLevel) => RANK[level] >= RANK[want];
  return {
    c: C,
    info: (m) => { if (at('info')) process.stderr.write(m + '\n'); },
    debug: (m) => { if (at('debug')) process.stderr.write(C.dim(m) + '\n'); },
    warn: (m) => { if (at('info')) process.stderr.write(C.yellow('! ' + m) + '\n'); },
    error: (m) => { if (at('info')) process.stderr.write(C.red('✗ ' + m) + '\n'); },
  };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated ${s.length - max} chars]`;
}

export function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
