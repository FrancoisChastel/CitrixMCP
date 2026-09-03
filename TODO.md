# CitrixMCP — TODO

MCP server (macOS) that drives a PowerShell session inside a Citrix/RDP window,
using the **synced clipboard** as the only transport. See `README.md` for design.

## Status legend
- [x] done · [~] in progress · [ ] not started

## Core
- [x] Project scaffold (package.json, tsconfig, .gitignore)
- [x] Config with env overrides (`src/config.ts`)
- [x] Wire protocol: frames, encode/decode, stop-and-wait ARQ (`src/protocol.ts`)
- [x] Clipboard port + macOS pbcopy/pbpaste impl (`src/clipboard.ts`)
- [x] Relay: ping/exec/put/get/shot over clipboard (`src/relay.ts`)
- [x] PowerShell command builders (`src/psbuilders.ts`)
- [x] MCP tool surface — 12 tools (`src/tools.ts`)
      ping, run, launch, list_windows, focus, send_keys, type, mouse,
      screenshot, processes, upload, download
- [x] Server entry / stdio transport (`src/index.ts`)
- [x] Windows helper / responder — PowerShell (`windows/rdt-agent.ps1`)
- [x] Windows helper / responder — Python, stdlib-only (`windows/rdt_agent.py`)
- [x] Loopback self-test — TS relay (`scripts/selftest.ts`)
- [x] Loopback self-test — Python responder (`scripts/selftest_py.py`)
- [x] TS <-> Python codec verified byte-identical (interchangeable helpers)
- [x] `npm run build` compiles clean
- [x] Full MCP-client feature test (`scripts/test-all.mjs`)
- [x] README with setup + MCP registration + safety + blocked-.ps1 workarounds

## Verification (live against the real Citrix session — host APPSWN13P, PS 5.1)
Full run: `node scripts/test-all.mjs` → 10 passed, 0 failed, 2 skipped.
- [x] All 12 tools advertised over MCP stdio
- [x] `rdt_ping` round-trips (~0.8s over Citrix clipboard)
- [x] `rdt_run` returns output; working dir persists (~1s)
- [x] `rdt_list_windows` (32 windows) and `rdt_processes` return JSON
- [x] `rdt_launch` starts a process and returns PID
- [x] `rdt_upload` + Windows-side SHA-256 match on 700 KB (multi-chunk)
- [x] `rdt_download` round-trip byte-identical; remote temp cleaned up
- [x] `rdt_screenshot` returns a valid 1728x1117 RGBA PNG of the desktop
- [x] `rdt_mouse` (move) and `rdt_focus` (path) OK
- [~] `rdt_type` / `rdt_send_keys` — pass with `--interactive` (opt-in; sends
      real keystrokes). Not run in the default safe pass.
- [x] Clipboard restore active during tests (RDT_RESTORE_CLIPBOARD=true)
- [ ] Register the MCP server in the user's Claude client and use tools in-session

## Packaging, CI & release
- [x] `npx`-style launch, no global install (`npx -y github:.../CitrixMCP`)
      via `prepare` auto-build + `files` + `bin` (rdt-mcp / citrix-mcp)
- [x] `npm test` = build + relay self-test + builder unit tests
- [x] Builder unit tests for the GUI tools (`scripts/test-builders.mjs`)
- [x] GitHub Actions CI: build + self-tests + tools/list smoke (`.github/workflows/ci.yml`)
- [x] Registered at **user scope** — `claude mcp add citrix -s user` → all sessions,
      absolute node path, survives Claude restarts + Citrix reconnect. ✔ Connected.
- [x] GitHub repo description + topics set (mcp, citrix, powershell, …)
- [x] MIT LICENSE + npm metadata (license/author/repository/keywords)
- [x] Open-source README: badges, Mermaid architecture + sequence diagrams
      (both validated), demo GIF (`docs/demo.gif`), 3-step onboarding
- [x] Pushed to origin/main; CI runs on push

## Nice-to-have / later
- [ ] Optional progress logging for large transfers
- [ ] Retry/backoff tuning + metrics on retransmits
- [ ] Publish to npm registry (currently git-install only)

## Notes / decisions
- Transport is clipboard-only (Citrix double-hop; no SSH/WinRM to the box).
- Windows helper is deliberately non-persistent, no-network, prints every command.
- Big clipboard payloads are supported here, so chunk size defaults high (256 KB).
- Repo: git@github.com:FrancoisChastel/CitrixMCP.git — pushed to `main`.
- Self-test + `npm run build` + MCP tools/list smoke test all green on the Mac.
- Remaining work is live verification inside the real Citrix session (see above).
