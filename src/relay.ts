/**
 * Mac-side initiator of the clipboard link. Implements stop-and-wait ARQ over
 * the single shared clipboard cell (see protocol.ts for the frame contract).
 *
 * Every public operation is serialized through a mutex because there is exactly
 * one clipboard cell: two exchanges must never be in flight at once. Each op is
 * also wrapped so the user's real clipboard content is restored afterward on a
 * best-effort basis.
 */

import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
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
  /** Helper's own version string (absent on pre-0.2 helpers). */
  agentVersion?: string;
  /** New helpers advertise gzip support so the server never sends compressed
   * bytes to an old helper that would write them without decompressing. */
  gzip?: boolean;
}

export interface ExecResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

export interface UploadResult {
  bytesWritten: number;
  wireBytes: number;
  compressed: boolean;
}

export interface DownloadResult {
  bytesReceived: number;
  wireBytes: number;
  compressed: boolean;
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
  private helperGzip: boolean | null = null;
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
      const info = reply.data as PingInfo;
      this.helperGzip = !!info.gzip;
      return info;
    });
  }

  /** True if the connected helper can decompress gzip transfers (cached). */
  private async gzipSupported(): Promise<boolean> {
    if (this.helperGzip === null) await this.ping();
    return this.helperGzip === true;
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

  /** Read a small file into memory (Windows -> Mac). Prefer getFileToDisk for large files. */
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
   * Upload a local file to the Windows session, streaming from disk so a
   * multi-GB file never sits in memory. With gzip, the file is compressed to a
   * Mac-side temp first (outside the clipboard lock) so fewer bytes travel and
   * the helper decompresses on arrival.
   */
  async putFileFromDisk(
    remotePath: string,
    localPath: string,
    opts: { overwrite?: boolean; gzip?: boolean } = {},
  ): Promise<UploadResult> {
    const overwrite = opts.overwrite ?? true;
    const gzip = (opts.gzip ?? false) && (await this.gzipSupported());
    const originalBytes = (await stat(localPath)).size;
    let sourcePath = localPath;
    let tempPath: string | null = null;
    if (gzip) {
      tempPath = join(tmpdir(), `rdt-up-${randomUUID()}.gz`);
      await pipeline(createReadStream(localPath), createGzip(), createWriteStream(tempPath));
      sourcePath = tempPath;
    }
    try {
      const wireBytes = (await stat(sourcePath)).size;
      const bytesWritten = await this.guard(async () => {
        const total = Math.max(1, Math.ceil(wireBytes / this.cfg.chunkBytes));
        const head: PutHead = { path: remotePath, totalBytes: wireBytes, overwrite, gzip };
        await this.transact("put", { seq: 0, total, data: head }, this.cfg.frameTimeoutMs);
        const fh = await open(sourcePath, "r");
        const buf = Buffer.allocUnsafe(this.cfg.chunkBytes);
        let ack: Frame | null = null;
        try {
          for (let i = 0; i < total; i++) {
            const { bytesRead } = await fh.read(buf, 0, this.cfg.chunkBytes, i * this.cfg.chunkBytes);
            const seq = i + 1;
            ack = await this.transact(
              "put",
              { seq, total, fin: seq === total, data: { chunk: buf.subarray(0, bytesRead).toString("base64") } },
              this.cfg.frameTimeoutMs,
            );
          }
        } finally {
          await fh.close();
        }
        const d = ack?.data as { bytesWritten?: number } | undefined;
        return d?.bytesWritten ?? originalBytes;
      });
      return { bytesWritten, wireBytes, compressed: gzip };
    } finally {
      if (tempPath) await rm(tempPath, { force: true });
    }
  }

  /**
   * Download a file from the Windows session straight to a local path, streaming
   * so a multi-GB file never sits in memory. With gzip, the helper compresses
   * before sending and the Mac decompresses after (outside the clipboard lock).
   */
  async getFileToDisk(
    remotePath: string,
    localPath: string,
    opts: { gzip?: boolean } = {},
  ): Promise<DownloadResult> {
    const gzip = (opts.gzip ?? false) && (await this.gzipSupported());
    const tempPath = gzip ? join(tmpdir(), `rdt-dn-${randomUUID()}.gz`) : localPath;
    let wireBytes = 0;
    try {
      wireBytes = await this.guard(async () => {
        const req: GetRequest = { path: remotePath, gzip };
        const first = await this.transact("get", { data: req }, this.cfg.frameTimeoutMs);
        const ws = createWriteStream(tempPath);
        try {
          const received = await this.receiveToStream(first, ws);
          ws.end();
          await once(ws, "finish");
          return received;
        } catch (err) {
          ws.destroy();
          throw err;
        }
      });
    } catch (err) {
      if (gzip) await rm(tempPath, { force: true });
      throw err;
    }
    if (gzip) {
      await pipeline(createReadStream(tempPath), createGunzip(), createWriteStream(localPath));
      await rm(tempPath, { force: true });
    }
    const bytesReceived = gzip ? (await stat(localPath)).size : wireBytes;
    return { bytesReceived, wireBytes, compressed: gzip };
  }

  /** Drain a multi-frame reply straight to a writable stream (no full buffering). */
  private async receiveToStream(first: Frame, ws: WriteStream): Promise<number> {
    let reply = first;
    let total = 0;
    for (;;) {
      const d = reply.data as { chunk?: string } | undefined;
      if (d?.chunk) {
        const bytes = Buffer.from(d.chunk, "base64");
        total += bytes.length;
        if (!ws.write(bytes)) await once(ws, "drain");
      }
      if (reply.fin) break;
      reply = await this.transact("ack", { data: { seq: reply.seq } }, this.cfg.frameTimeoutMs);
    }
    return total;
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
