/**
 * Live binary file-transfer test over the real Citrix clipboard channel.
 * Uploads a 700 KB payload (forces multi-chunk), verifies the hash on the
 * Windows side, downloads it back, checks the round-trip is byte-identical,
 * then deletes the remote temp file.
 */

import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";

process.env.RDT_FRAME_TIMEOUT_MS ||= "30000";

const { MacClipboard } = await import("../dist/clipboard.js");
const { Relay } = await import("../dist/relay.js");
const { config } = await import("../dist/config.js");

const scratch =
  "/private/tmp/claude-501/-Users-francoischastel-Documents-github-com-FrancoisChastel-RemoteDesktopTerminal/02911505-e273-4fbf-8d8f-56253c391571/scratchpad";
const localSrc = `${scratch}/rdt_payload.bin`;
const localBack = `${scratch}/rdt_roundtrip.bin`;
const remote = "C:\\Users\\fchastel2\\rdt_selftest_DELETE_ME.bin";

const sha = (buf) => createHash("sha256").update(buf).digest("hex").toUpperCase();

const relay = new Relay(new MacClipboard(), config);

// Deterministic 700 KB payload (> 256 KB chunk size -> 3 frames).
const payload = Buffer.alloc(700 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 131 + 17) & 0xff;
const localHash = sha(payload);
await writeFile(localSrc, payload);

try {
  console.log(`→ upload ${payload.length} bytes to ${remote} ...`);
  const up = await relay.putFile(remote, payload, true);
  console.log(`  uploaded ${up.bytesWritten} bytes`);

  console.log("→ verify hash on the Windows side ...");
  const r = await relay.exec(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${remote}').Hash`, 20000);
  const remoteHash = r.output.trim();
  console.log(`  remote:  ${remoteHash}\n  local:   ${localHash}`);
  console.log(remoteHash === localHash ? "  ✅ remote hash matches" : "  ❌ remote hash MISMATCH");

  console.log("→ download it back ...");
  const back = await relay.getFile(remote);
  await writeFile(localBack, back);
  const backHash = sha(back);
  console.log(`  ${back.length} bytes, hash ${backHash}`);
  console.log(backHash === localHash ? "  ✅ round-trip byte-identical" : "  ❌ round-trip MISMATCH");

  console.log("→ cleanup remote temp file ...");
  await relay.exec(`Remove-Item -LiteralPath '${remote}' -Force; 'removed'`, 15000);
  console.log("  done");

  const ok = remoteHash === localHash && backHash === localHash;
  console.log(ok ? "\n✅ FILE TRANSFER OK" : "\n❌ FILE TRANSFER FAILED");
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error("❌ " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
