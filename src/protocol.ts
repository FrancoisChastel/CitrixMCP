/**
 * Wire protocol shared by the Mac MCP server and the Windows PowerShell helper.
 *
 * The clipboard is a single shared cell that Citrix keeps in sync between the
 * two machines. We treat it as a half-duplex link and run a classic
 * stop-and-wait ARQ (one outstanding frame at a time) over it:
 *
 *   - Every frame is a full clipboard write of `FRAME_PREFIX + base64(json)`.
 *   - `n` is a single monotonic counter shared across the whole session. A
 *     receiver only acts on a frame whose `n` is exactly one past the last it
 *     acted on; anything <= that is a duplicate (retransmit) and anything the
 *     wrong `role` is our own echo. This gives ordering + dedup for free.
 *   - `role` is who wrote the frame: 'm' = Mac initiator, 'w' = Windows helper.
 *     Each side ignores frames it authored, so neither reacts to its own write.
 *   - `sid` scopes a session to one MCP-server run, so stale frames from a
 *     previous run are ignored.
 *
 * This file is the single source of truth for the format. windows/rdt-agent.ps1
 * implements the exact same shape and MUST be kept in sync with it.
 */

import { FRAME_PREFIX, PROTOCOL_VERSION } from "./config.js";

export type Role = "m" | "w";

export type Op =
  | "ping" // liveness + handshake
  | "exec" // run a PowerShell command; reply streams stdout chunks
  | "put" // Mac -> Windows file write; Mac streams chunks
  | "get" // Windows -> Mac file read; Windows streams chunks
  | "shot" // capture the Windows desktop; reply streams PNG chunks
  | "ack" // acknowledge a received chunk so the peer sends the next
  | "err"; // structured error reply

export interface Frame {
  /** Protocol version. */
  v: number;
  /** Session id, owned by the Mac initiator, constant for one server run. */
  sid: string;
  /** Monotonic frame number across the whole session. */
  n: number;
  /** Author of this frame. */
  role: Role;
  /** Operation this frame belongs to. */
  op: Op;
  /** Chunk index within a multi-frame payload (0-based). */
  seq?: number;
  /** Total chunks in a multi-frame payload, when known. */
  total?: number;
  /** True on the final frame of a multi-frame reply. */
  fin?: boolean;
  /** Operation-specific payload. */
  data?: unknown;
}

/** Payload of an `exec` request (role 'm'). */
export interface ExecRequest {
  cmd: string;
  timeoutMs?: number;
}

/** Metadata carried on the final `exec` reply frame (role 'w'). */
export interface ExecResultMeta {
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

/** Payload of a `put` request head frame (role 'm', seq 0 announces the file). */
export interface PutHead {
  path: string;
  totalBytes: number;
  overwrite: boolean;
}

/** Payload of a `get` request frame (role 'm'). */
export interface GetRequest {
  path: string;
}

export function encodeFrame(frame: Frame): string {
  const json = JSON.stringify(frame);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return FRAME_PREFIX + b64;
}

/**
 * Parse a clipboard value into a Frame, or null if it is not one of ours
 * (normal user clipboard content, a truncated frame, etc.). Never throws.
 */
export function decodeFrame(raw: string | null | undefined): Frame | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(FRAME_PREFIX)) return null;
  try {
    const b64 = trimmed.slice(FRAME_PREFIX.length);
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Frame;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.v !== PROTOCOL_VERSION) return null;
    if (parsed.role !== "m" && parsed.role !== "w") return null;
    if (typeof parsed.n !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

let counter = 0;

/** Generate a session id unique to this process run. */
export function newSessionId(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${counter}-${rand}`;
}
