/**
 * Central configuration. Every tunable lives here and can be overridden with an
 * environment variable so the same build works across different Citrix setups.
 */

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
};

/** Human-facing tool version. Keep in sync with package.json and the helpers. */
export const APP_VERSION = "0.2.0";

/** Wire-protocol version. Bump only on a breaking frame-format change. */
export const PROTOCOL_VERSION = 1;

/**
 * Frame marker. A clipboard value is "ours" only if it starts with this prefix.
 * Everything else (a URL the user copied, plain text, etc.) is ignored by both
 * sides, so normal clipboard use never gets mistaken for a command.
 */
export const FRAME_PREFIX = "RDT1|";

export const config = {
  /** How often each side re-reads the clipboard while waiting, in ms. */
  pollIntervalMs: num("RDT_POLL_INTERVAL_MS", 250),

  /**
   * If the peer hasn't answered within this window, we re-assert (retransmit)
   * our last frame. Covers the case where the user copied something else and
   * clobbered the in-flight frame.
   */
  retransmitAfterMs: num("RDT_RETRANSMIT_MS", 2500),

  /** Hard ceiling for a single frame round-trip before we give up with an error. */
  frameTimeoutMs: num("RDT_FRAME_TIMEOUT_MS", 60_000),

  /** Default ceiling the model waits for a whole command to finish. */
  execTimeoutMs: num("RDT_EXEC_TIMEOUT_MS", 120_000),

  /**
   * Raw bytes of payload per frame before base64. Citrix clipboard here handles
   * large payloads, so this is generous; lower it if you see truncation.
   */
  chunkBytes: num("RDT_CHUNK_BYTES", 256 * 1024),

  /** Best-effort: restore the Mac clipboard to its prior value after each op. */
  restoreClipboard: bool("RDT_RESTORE_CLIPBOARD", true),

  /** Settle delay after writing before the first read, lets Citrix sync catch up. */
  writeSettleMs: num("RDT_WRITE_SETTLE_MS", 60),
} as const;

export type Config = typeof config;
