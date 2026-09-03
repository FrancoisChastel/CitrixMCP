/**
 * Full feature test for the CitrixMCP server. Spawns the built server
 * (dist/index.js) as a real MCP client would, then exercises every tool over
 * the MCP stdio interface against the live Windows helper.
 *
 * Prerequisites:
 *   1. npm run build
 *   2. the Windows helper (rdt-agent.ps1 or rdt_agent.py) is running in the
 *      Citrix session, and the Citrix clipboard is synced.
 *
 * Usage:
 *   node scripts/test-all.mjs                # safe: no input sent to the session
 *   node scripts/test-all.mjs --interactive  # also tests keyboard input via Notepad
 *   node scripts/test-all.mjs --shot-dir DIR # where to save the screenshot PNG
 *
 * "Safe" tests never send keystrokes/clicks into the live desktop. The
 * --interactive tests launch Notepad, type into it, and close it without saving.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2);
const interactive = argv.includes("--interactive");
const shotDir = (() => {
  const i = argv.indexOf("--shot-dir");
  return i !== -1 && argv[i + 1] ? argv[i + 1] : root;
})();

const EXPECTED_TOOLS = [
  "rdt_ping", "rdt_run", "rdt_launch", "rdt_send_keys", "rdt_screenshot",
  "rdt_upload", "rdt_download", "rdt_list_windows", "rdt_focus", "rdt_type",
  "rdt_mouse", "rdt_processes",
];

let pass = 0, fail = 0, skip = 0;
const line = (tag, name, detail) =>
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
const ok = (name, detail) => { pass++; line("PASS", name, detail); };
const bad = (name, detail) => { fail++; line("FAIL", name, detail); };
const skipped = (name, detail) => { skip++; line("SKIP", name, detail); };

const textOf = (res) =>
  (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const imageOf = (res) => (res?.content ?? []).find((c) => c.type === "image");
const firstLine = (s) => s.split("\n").map((l) => l.trim()).find((l) => l) ?? "";

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "index.js")],
    env: { ...process.env, RDT_FRAME_TIMEOUT_MS: process.env.RDT_FRAME_TIMEOUT_MS ?? "30000" },
    stderr: "ignore",
  });
  const client = new Client({ name: "rdt-tester", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, text: textOf(res), isError: !!res.isError };
  };

  console.log(`\nCitrixMCP full feature test  (${interactive ? "interactive" : "safe"} mode)\n`);

  // 1. tools present
  const listed = (await client.listTools()).tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((t) => !listed.includes(t));
  missing.length === 0
    ? ok("all 12 tools advertised")
    : bad("tools advertised", "missing: " + missing.join(", "));

  // 2. ping — abort early if the helper isn't reachable
  const ping = await call("rdt_ping");
  if (ping.isError || !/host:/i.test(ping.text)) {
    bad("rdt_ping", ping.text.replace(/\n/g, " ").slice(0, 160));
    console.log("\nHelper not reachable — is it running and is the clipboard synced? Aborting.");
    await client.close();
    process.exit(1);
  }
  ok("rdt_ping", firstLine(ping.text.split("host:")[1] ? "host:" + ping.text.split("host:")[1] : ping.text));

  // 3. run
  const who = await call("rdt_run", { command: "whoami" });
  who.isError ? bad("rdt_run", who.text) : ok("rdt_run", firstLine(who.text));

  // 4. list windows
  const win = await call("rdt_list_windows");
  try {
    const arr = JSON.parse(win.text);
    ok("rdt_list_windows", `${arr.length} window(s)`);
  } catch { bad("rdt_list_windows", win.text.slice(0, 120)); }

  // 5. processes
  const procs = await call("rdt_processes", { top: 10 });
  try {
    const arr = JSON.parse(procs.text);
    ok("rdt_processes", `${arr.length} process(es)`);
  } catch { bad("rdt_processes", procs.text.slice(0, 120)); }

  // 6. launch a harmless, self-closing process
  const launch = await call("rdt_launch", { program: "cmd.exe", args: "/c exit" });
  /launched/i.test(launch.text) ? ok("rdt_launch", firstLine(launch.text)) : bad("rdt_launch", launch.text.slice(0, 120));

  // 7. upload + download round-trip through a remote temp file
  const tmp = await call("rdt_run", { command: "[System.IO.Path]::GetTempFileName()" });
  const remotePath = firstLine(tmp.text);
  const payload = `rdt round-trip ${Date.now()} ✓ line2\nsecond line`;
  const up = await call("rdt_upload", { remotePath, content: payload, overwrite: true });
  const localBack = join(shotDir, "rdt_download.txt");
  const down = await call("rdt_download", { remotePath, localPath: localBack });
  let back = "";
  try { back = (await import("node:fs")).readFileSync(localBack, "utf8"); } catch {}
  back === payload
    ? ok("rdt_upload + rdt_download", "round-trip identical")
    : bad("rdt_upload + rdt_download", up.isError ? up.text : down.text || "mismatch");
  await call("rdt_run", { command: `Remove-Item -LiteralPath '${remotePath}' -Force -ErrorAction SilentlyContinue; 'ok'` });

  // 8. screenshot
  const shot = await call("rdt_screenshot");
  const img = imageOf(shot.res);
  if (img && img.data && img.data.length > 1000) {
    const shotPath = join(shotDir, "rdt_screenshot.png");
    await writeFile(shotPath, Buffer.from(img.data, "base64"));
    ok("rdt_screenshot", `PNG ${Buffer.from(img.data, "base64").length} bytes -> ${shotPath}`);
  } else {
    bad("rdt_screenshot", textOf(shot.res).slice(0, 120) || "no image returned");
  }

  // 9. mouse move only (non-destructive)
  const mouse = await call("rdt_mouse", { x: 200, y: 200, action: "move" });
  /ok/i.test(mouse.text) ? ok("rdt_mouse (move)") : bad("rdt_mouse (move)", mouse.text.slice(0, 120));

  // 10. focus a name that shouldn't exist — exercises the path without stealing focus
  const focus = await call("rdt_focus", { title: "__rdt_no_such_window__" });
  /not found|activated/i.test(focus.text) ? ok("rdt_focus", firstLine(focus.text)) : bad("rdt_focus", focus.text.slice(0, 120));

  // 11-12. keyboard input — only with --interactive
  if (!interactive) {
    skipped("rdt_type", "use --interactive (sends keystrokes to the live session)");
    skipped("rdt_send_keys", "use --interactive");
  } else {
    const np = await call("rdt_launch", { program: "notepad.exe" });
    await new Promise((r) => setTimeout(r, 1200));
    const typed = await call("rdt_type", { text: "RDT keyboard test 123 (100% ok)\nsecond line", windowTitle: "Notepad" });
    const keys = await call("rdt_send_keys", { keys: "{END}", windowTitle: "Notepad" });
    !typed.isError ? ok("rdt_type", "typed into Notepad") : bad("rdt_type", typed.text.slice(0, 120));
    !keys.isError ? ok("rdt_send_keys", "sent {END}") : bad("rdt_send_keys", keys.text.slice(0, 120));
    const shot2 = await call("rdt_screenshot");
    const img2 = imageOf(shot2.res);
    if (img2?.data) await writeFile(join(shotDir, "rdt_notepad.png"), Buffer.from(img2.data, "base64"));
    // close Notepad without saving
    await call("rdt_run", { command: "Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue; 'closed'" });
  }

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness crashed:", err);
  process.exit(1);
});
