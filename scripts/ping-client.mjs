/**
 * Live connectivity test. Runs the real Mac-side relay against the actual macOS
 * clipboard (which Citrix syncs to the Windows helper) to prove the round-trip.
 * Usage:  node scripts/ping-client.mjs
 */

// Short timeouts so a missing helper fails fast instead of hanging a minute.
process.env.RDT_FRAME_TIMEOUT_MS ||= "20000";
process.env.RDT_DEBUG ||= "1";

const { MacClipboard } = await import("../dist/clipboard.js");
const { Relay } = await import("../dist/relay.js");
const { config } = await import("../dist/config.js");

const relay = new Relay(new MacClipboard(), config);

try {
  console.log("→ ping...");
  const info = await relay.ping();
  console.log("✅ helper alive:", JSON.stringify(info));

  console.log("→ run: whoami + location + PS version...");
  const res = await relay.exec(
    "whoami; (Get-Location).Path; $PSVersionTable.PSVersion.ToString()",
    15000,
  );
  console.log("✅ exec output:\n" + res.output);
  console.log(`(exit ${res.exitCode}, ${res.durationMs}ms)`);
  process.exit(0);
} catch (err) {
  console.error("❌ " + (err instanceof Error ? err.message : String(err)));
  console.error(
    "\nChecklist:\n" +
      "  - Is the helper running in the RDP PowerShell (banner shown, no errors)?\n" +
      "  - Is Citrix clipboard sync ON and bidirectional?\n" +
      "  - Try clicking into the Citrix window once so it has focus, then re-run.\n" +
      "  - Copy some text on the Mac and paste in Windows to confirm sync works.",
  );
  process.exit(1);
}
