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
- [x] MCP tool surface (`src/tools.ts`)
- [x] Server entry / stdio transport (`src/index.ts`)
- [x] Windows helper / responder — PowerShell (`windows/rdt-agent.ps1`)
- [x] Windows helper / responder — Python, stdlib-only (`windows/rdt_agent.py`)
- [x] Loopback self-test — TS relay (`scripts/selftest.ts`)
- [x] Loopback self-test — Python responder (`scripts/selftest_py.py`)
- [x] TS <-> Python codec verified byte-identical (interchangeable helpers)
- [x] `npm run build` compiles clean
- [x] README with setup + MCP registration + safety + blocked-.ps1 workarounds

## Verification (live against the real Citrix session)
- [x] PowerShell helper runs (SRP on file worked around); host APPSWN13P, PS 5.1
- [x] `ping` round-trips (~0.8s over Citrix clipboard)
- [x] `exec` returns output; whoami/Get-Location/PS version OK (~1s)
- [x] `upload` + Windows-side SHA-256 match on 700 KB (multi-chunk) payload
- [x] `download` round-trip byte-identical (hash match); remote temp cleaned up
- [ ] `rdt_screenshot` — PENDING: captures the real desktop; run on user's OK
- [ ] Register the MCP server in the user's Claude client and use the tools live
- [ ] Tune chunk size / poll interval if needed (defaults fine so far)
- [x] Clipboard restore active during tests (RDT_RESTORE_CLIPBOARD=true)

## Nice-to-have / later
- [ ] `rdt_list_windows` + `rdt_focus` helpers for GUI targeting
- [ ] Optional progress logging for large transfers
- [ ] Retry/backoff tuning + metrics on retransmits
- [ ] Packaging: `npx` invocation without global install
- [ ] Unit tests for psbuilders escaping + protocol codec

## Notes / decisions
- Transport is clipboard-only (Citrix double-hop; no SSH/WinRM to the box).
- Windows helper is deliberately non-persistent, no-network, prints every command.
- Big clipboard payloads are supported here, so chunk size defaults high (256 KB).
- Repo: git@github.com:FrancoisChastel/CitrixMCP.git — pushed to `main`.
- Self-test + `npm run build` + MCP tools/list smoke test all green on the Mac.
- Remaining work is live verification inside the real Citrix session (see above).
