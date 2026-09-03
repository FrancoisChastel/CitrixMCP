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

## Verification (needs the real Citrix session)
- [ ] Pick a working helper: `.ps1` blocked by SRP on this box — check
      `$ExecutionContext.SessionState.LanguageMode`; if ConstrainedLanguage use
      the Python helper, else PowerShell via `Get-Content ... | iex`
- [ ] `python rdt_agent.py --dry-run` starts; is Python present? (`py --version`)
- [ ] Run helper; `rdt_ping` round-trips
- [ ] `rdt_run` executes and returns output; working dir persists
- [ ] `rdt_screenshot` returns a PNG of the remote desktop
- [ ] `rdt_upload` / `rdt_download` transfer a binary file intact (hash match)
- [ ] Tune chunk size / poll interval for this Citrix link
- [ ] Confirm clipboard restore behaves (user clipboard not trashed)

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
