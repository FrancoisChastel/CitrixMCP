/**
 * Mac-side initiator of the clipboard link. Implements stop-and-wait ARQ over
 * the single shared clipboard cell (see protocol.ts for the frame contract).
 *
 * Every public operation is serialized through a mutex because there is exactly
 * one clipboard cell: two exchanges must never be in flight at once. Each op is
 * also wrapped so the user's real clipboard content is restored afterward on a
 * best-effort basis.
 */

import type { ClipboardPort } from "./clipboard.js";
import type { Config } from "./config.js";
import { PROTOCOL_VERSION } from "./config.js";
import {
  decodeFrame,
  encodeFrame,
  newSessionId,
  type ExecResultMeta,
  type Frame,
  type GetRequest,
  type Op,
  type PutHead,
} from "./protocol.js";
import { Mutex, log, now, sleep } from "./util.js";

export interface PingInfo {
  version: number;
  host: string;
  user: string;
  pid: number;
  powershell: string;
}

export interface ExecResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

interface TransactExtra {
  seq?: number;
  total?: number;
  fin?: boolean;
  data?: unknown;
}

export class Relay {
  private readonly sid = newSessionId();
  private lastN = 0;
  private lastSentEncoded: string | null = null;
  private readonly mutex = new Mutex();

  constructor(
    private readonly clip: ClipboardPort,
    private readonly cfg: Config,
  ) {}

  get sessionId(): string {
    return this.sid;
  }

  /** Round-trip a liveness/handshake frame. Confirms the Windows helper is up. */
  ping(): Promise<PingInfo> {
    return this.guard(async () => {
      const reply = await this.transact(
        "ping",
        { data: { t: now() } },
        this.cfg.frameTimeoutMs,
      );
      return reply.data as PingInfo;
    });
  }

  /** Run one PowerShell command and collect its merged output. */
  exec(cmd: string, timeoutMs: number): Promise<ExecResult> {
    return this.guard(async () => {
      const firstTimeout = Math.max(this.cfg.frameTimeoutMs, timeoutMs + 10_000);
      const first = await this.transact(
        "exec",
        { data: { cmd, timeoutMs } },
        firstTimeout,
      );
      const { buffer, last } = await this.collectChunks(first);
      const meta = (last.data as { meta?: ExecResultMeta } | undefined)?.meta;
      return {
        output: buffer.toString("utf8"),
        exitCode: meta?.exitCode ?? null,
        durationMs: meta?.durationMs ?? 0,
        truncated: meta?.truncated ?? false,
      };
    });
  }

  /** Capture the Windows session desktop as PNG bytes (streamed, no disk). */
  screenshot(): Promise<Buffer> {
    return this.guard(async () => {
      const first = await this.transact("shot", {}, this.cfg.frameTimeoutMs);
      const { buffer } = await this.collectChunks(first);
      return buffer;
    });
  }

  /** Write bytes to a file inside the Windows session (Mac -> Windows). */
  putFile(
    remotePath: string,
    data: Buffer,
    overwrite: boolean,
  ): Promise<{ bytesWritten: number }> {
    return this.guard(async () => {
      const total = Math.max(1, Math.ceil(data.length / this.cfg.chunkBytes));
      const head: PutHead = {
        path: remotePath,
        totalBytes: data.length,
        overwrite,
      };
      await this.transact(
        "put",
        { seq: 0, total, data: head },
        this.cfg.frameTimeoutMs,
      );
      let ack: Frame | null = null;
      for (let i = 0; i < total; i++) {
        const start = i * this.cfg.chunkBytes;
        const slice = data.subarray(start, start + this.cfg.chunkBytes);
        const seq = i + 1;
        ack = await this.transact(
          "put",
          {
            seq,
            total,
            fin: seq === total,
            data: { chunk: slice.toString("base64") },
          },
          this.cfg.frameTimeoutMs,
        );
      }
      const d = ack?.data as { bytesWritten?: number } | undefined;
      return { bytesWritten: d?.bytesWritten ?? data.length };
    });
  }

  /** Read a file out of the Windows session (Windows -> Mac). */
  getFile(remotePath: string): Promise<Buffer> {
    return this.guard(async () => {
      const req: GetRequest = { path: remotePath };
      const first = await this.transact(
        "get",
        { data: req },
        this.cfg.frameTimeoutMs,
      );
      const { buffer } = await this.collectChunks(first);
      return buffer;
    });
  }

  /**
   * Drain a multi-frame reply: append each chunk and ACK to pull the next,
   * until the frame marked `fin`. Returns the concatenated bytes and the final
   * frame (whose data may carry op-specific metadata).
   */
  private async collectChunks(
    first: Frame,
  ): Promise<{ buffer: Buffer; last: Frame }> {
    const chunks: Buffer[] = [];
    let reply = first;
    for (;;) {
      const d = reply.data as { chunk?: string } | undefined;
      if (d?.chunk) chunks.push(Buffer.from(d.chunk, "base64"));
      if (reply.fin) break;
      reply = await this.transact(
        "ack",
        { data: { seq: reply.seq } },
        this.cfg.frameTimeoutMs,
      );
    }
    return { buffer: Buffer.concat(chunks), last: reply };
  }

  /** Serialize + best-effort restore of the user's clipboard around an op. */
  private guard<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      let saved: string | null = null;
      if (this.cfg.restoreClipboard) {
        try {
          const current = await this.clip.read();
          if (current.trim() !== "" && decodeFrame(current) === null) {
            saved = current;
          }
        } catch {
          /* ignore: restore is best-effort */
        }
      }
      try {
        return await fn();
      } finally {
        if (saved !== null) {
          try {
            await this.clip.write(saved);
            this.lastSentEncoded = null;
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  /**
   * Write one frame (role 'm') and wait for the peer's reply frame (role 'w'
   * with n === ours + 1). Retransmits our frame if the peer goes quiet, which
   * recovers from the user clobbering the clipboard mid-exchange.
   */
  private async transact(
    op: Op,
    extra: TransactExtra,
    timeoutMs: number,
  ): Promise<Frame> {
    const n = this.lastN + 1;
    const frame: Frame = {
      v: PROTOCOL_VERSION,
      sid: this.sid,
      n,
      role: "m",
      op,
      ...extra,
    };
    this.lastN = n;
    const encoded = encodeFrame(frame);
    this.lastSentEncoded = encoded;
    await this.clip.write(encoded);
    log("debug", `sent n=${n} op=${op}`, { seq: extra.seq, fin: extra.fin });

    let lastWrite = now();
    const deadline = now() + timeoutMs;
    const expectN = n + 1;
    await sleep(this.cfg.writeSettleMs);

    while (now() < deadline) {
      await sleep(this.cfg.pollIntervalMs);
      let raw: string;
      try {
        raw = await this.clip.read();
      } catch {
        continue;
      }
      const f = decodeFrame(raw);
      if (f && f.sid === this.sid && f.role === "w" && f.n === expectN) {
        this.lastN = f.n;
        if (f.op === "err") {
          const msg =
            (f.data as { message?: string } | undefined)?.message ??
            "unknown error";
          throw new Error(`remote helper error: ${msg}`);
        }
        log("debug", `recv n=${f.n} op=${f.op}`, { seq: f.seq, fin: f.fin });
        return f;
      }
      if (now() - lastWrite >= this.cfg.retransmitAfterMs && this.lastSentEncoded) {
        await this.clip.write(this.lastSentEncoded);
        lastWrite = now();
        log("debug", `retransmit n=${n} op=${op}`);
      }
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for reply to frame n=${n} (op=${op}). ` +
        `Is the Windows helper running and is the Citrix clipboard synced?`,
    );
  }
}
