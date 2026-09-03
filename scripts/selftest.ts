/**
 * Loopback self-test. Runs the real Mac-side Relay against an in-process
 * responder that mirrors windows/rdt-agent.ps1, both sharing one in-memory
 * clipboard. Exercises the full stop-and-wait protocol (ping, exec, upload,
 * download, screenshot) with a tiny chunk size so the multi-frame paths run.
 *
 * Run after `npm run build`:  node --experimental-strip-types scripts/selftest.ts
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryClipboard } from "../dist/clipboard.js";
import { Relay } from "../dist/relay.js";
import { decodeFrame, encodeFrame } from "../dist/protocol.js";

const cfg = {
  pollIntervalMs: 4,
  retransmitAfterMs: 300,
  frameTimeoutMs: 5000,
  execTimeoutMs: 5000,
  chunkBytes: 64, // tiny on purpose: forces multi-chunk transfers
  restoreClipboard: false,
  writeSettleMs: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitBytes(buf, size) {
  if (!buf || buf.length === 0) return [""];
  const out = [];
  for (let i = 0; i < buf.length; i += size) {
    out.push(buf.subarray(i, i + size).toString("base64"));
  }
  return out;
}

/** In-process stand-in for the Windows helper. Mirrors rdt-agent.ps1. */
class SimAgent {
  constructor(clip, chunkBytes) {
    this.clip = clip;
    this.chunkBytes = chunkBytes;
    this.sid = null;
    this.lastSeen = 0;
    this.out = null;
    this.put = null;
    this.fs = new Map();
    this.running = true;
  }

  reply(n, op, opts = {}) {
    const frame = { v: 1, sid: this.sid, n, role: "w", op };
    if (opts.seq !== undefined) frame.seq = opts.seq;
    if (opts.total !== undefined) frame.total = opts.total;
    if (opts.fin) frame.fin = true;
    if (opts.data !== undefined) frame.data = opts.data;
    return encodeFrame(frame);
  }

  startOut(buf, meta, op) {
    const chunks = splitBytes(buf, this.chunkBytes);
    this.out = { chunks, total: chunks.length, meta, nextSeq: 1, op };
  }

  emit(incomingN, seq) {
    const total = this.out.total;
    const fin = seq >= total - 1;
    const data = { chunk: this.out.chunks[seq] };
    if (fin && this.out.meta) data.meta = this.out.meta;
    const op = this.out.op;
    const frame = this.reply(incomingN + 1, op, { seq, total, fin, data });
    if (fin) this.out = null;
    return frame;
  }

  process(f) {
    switch (f.op) {
      case "ping":
        return this.reply(f.n + 1, "ping", {
          fin: true,
          data: { version: 1, host: "SIM", user: "sim", pid: 42, powershell: "sim-5.1", gzip: true },
        });
      case "exec": {
        const out = `echo:${f.data.cmd}\n`.repeat(40);
        this.startOut(Buffer.from(out, "utf8"), { exitCode: 0, durationMs: 1, truncated: false }, "exec");
        return this.emit(f.n, 0);
      }
      case "get": {
        const b = this.fs.get(f.data.path);
        if (!b) return this.reply(f.n + 1, "err", { fin: true, data: { message: "not found" } });
        this.startOut(f.data.gzip ? gzipSync(b) : b, null, "get");
        return this.emit(f.n, 0);
      }
      case "shot": {
        const b = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500, 7)]);
        this.startOut(b, null, "shot");
        return this.emit(f.n, 0);
      }
      case "put": {
        if (f.seq === 0) {
          this.put = { path: f.data.path, chunks: [], gzip: !!f.data.gzip };
          return this.reply(f.n + 1, "ack", { data: { ready: true } });
        }
        this.put.chunks.push(Buffer.from(f.data.chunk, "base64"));
        if (f.fin) {
          const wire = Buffer.concat(this.put.chunks);
          const buf = this.put.gzip ? gunzipSync(wire) : wire;
          this.fs.set(this.put.path, buf);
          const bytesWritten = buf.length;
          this.put = null;
          return this.reply(f.n + 1, "ack", { fin: true, data: { ok: true, bytesWritten } });
        }
        return this.reply(f.n + 1, "ack", { data: { seq: f.seq } });
      }
      case "ack": {
        const seq = this.out.nextSeq++;
        return this.emit(f.n, seq);
      }
      default:
        return this.reply(f.n + 1, "err", { fin: true, data: { message: `unknown op ${f.op}` } });
    }
  }

  async loop() {
    while (this.running) {
      await sleep(3);
      const raw = await this.clip.read();
      const f = decodeFrame(raw);
      if (!f || f.role !== "m") continue;
      if (f.sid !== this.sid) {
        this.sid = f.sid;
        this.lastSeen = 0;
        this.out = null;
        this.put = null;
      }
      if (f.n > this.lastSeen) {
        this.lastSeen = f.n;
        const reply = this.process(f);
        await this.clip.write(reply);
      }
    }
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const clip = new MemoryClipboard();
  const relay = new Relay(clip, cfg);
  const agent = new SimAgent(clip, cfg.chunkBytes);
  agent.loop();

  console.log("Running loopback self-test (tiny 64B chunks)...");

  const ping = await relay.ping();
  check("ping round-trips", ping.host === "SIM" && ping.version === 1, `host=${ping.host}`);

  const exec = await relay.exec("Get-Date", 5000);
  check(
    "exec streams multi-chunk output",
    exec.output.includes("echo:Get-Date") && exec.exitCode === 0,
    `exit=${exec.exitCode} len=${exec.output.length}`,
  );

  // Upload a random binary, then download it back — must be byte-identical.
  const payload = Buffer.from(
    Array.from({ length: 5000 }, (_, i) => (i * 31 + 7) & 0xff),
  );
  const up = await relay.putFile("C:\\tmp\\a.bin", payload, true);
  check("upload reports byte count", up.bytesWritten === payload.length, `bytes=${up.bytesWritten}`);

  const down = await relay.getFile("C:\\tmp\\a.bin");
  check("download round-trips identical bytes", Buffer.compare(down, payload) === 0, `len=${down.length}`);

  const shot = await relay.screenshot();
  check(
    "screenshot returns PNG bytes",
    shot.length === 504 && shot[0] === 0x89 && shot[1] === 0x50,
    `len=${shot.length}`,
  );

  // Disk-streaming + gzip round-trip through the real relay methods.
  const dir = mkdtempSync(join(tmpdir(), "rdt-test-"));
  const bigPayload = Buffer.concat(
    Array.from({ length: 300 }, () => Buffer.from("the quick brown fox 0123456789\n")),
  ); // compressible, ~9 KB -> many 64B chunks
  const srcFile = join(dir, "src.bin");
  const outFile = join(dir, "out.bin");
  writeFileSync(srcFile, bigPayload);

  const upGz = await relay.putFileFromDisk("C:\\tmp\\big.bin", srcFile, { gzip: true });
  check(
    "gzip upload streams + decompresses on the far side",
    upGz.bytesWritten === bigPayload.length && upGz.wireBytes < bigPayload.length,
    `orig=${bigPayload.length} wire=${upGz.wireBytes}`,
  );

  const dnGz = await relay.getFileToDisk("C:\\tmp\\big.bin", outFile, { gzip: true });
  const roundTrip = readFileSync(outFile);
  check(
    "gzip download streams to disk, byte-identical",
    dnGz.bytesReceived === bigPayload.length && Buffer.compare(roundTrip, bigPayload) === 0,
    `len=${roundTrip.length} wire=${dnGz.wireBytes}`,
  );

  // Non-gzip disk streaming too.
  const dnRaw = await relay.getFileToDisk("C:\\tmp\\big.bin", outFile, { gzip: false });
  check("raw download streams to disk", Buffer.compare(readFileSync(outFile), bigPayload) === 0, `len=${dnRaw.bytesReceived}`);

  agent.running = false;
  await sleep(10);

  console.log(failures === 0 ? "\nALL PASS ✅" : `\n${failures} FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("self-test crashed:", err);
  process.exit(1);
});
