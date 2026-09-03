/**
 * Small shared helpers. Logging goes to stderr only: stdout is reserved for the
 * MCP stdio transport and must never carry anything else.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const now = (): number => Date.now();

type Level = "info" | "warn" | "error" | "debug";

const debugEnabled = /^(1|true|yes|on)$/i.test(process.env.RDT_DEBUG ?? "");

export function log(level: Level, msg: string, extra?: unknown): void {
  if (level === "debug" && !debugEnabled) return;
  const ts = new Date().toISOString();
  const line =
    extra === undefined
      ? `[rdt ${ts}] ${level}: ${msg}`
      : `[rdt ${ts}] ${level}: ${msg} ${safeJson(extra)}`;
  process.stderr.write(line + "\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Run async tasks strictly one at a time. The relay owns the single clipboard
 * cell, so every operation must be serialized to avoid two exchanges colliding.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive regardless of individual task outcome.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
