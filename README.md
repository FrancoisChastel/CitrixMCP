# CitrixMCP — Remote Desktop Terminal

An MCP server that lets an AI agent (or you, through one) **control a Windows
PowerShell session that lives inside a Citrix / RDP window** — run commands,
launch programs, send keystrokes, screenshot the desktop, and move files in and
out — using the **synced clipboard** as the only transport.

## Why the clipboard?

The target machine here is reached through a locked-down double hop:

```
 Mac  ──Citrix Workspace──▶  published mstsc.exe  ──RDP──▶  Windows box + PowerShell
```

There is no direct SSH or WinRM path to the Windows box. The one channel that
reliably crosses all three boundaries is the **clipboard**, which Citrix keeps
synced in both directions. This project turns that shared clipboard cell into a
reliable request/response link.

```
┌─────────────────────────┐         clipboard (Citrix-synced)        ┌──────────────────────────┐
│  Mac: MCP server        │  ⇄  RDT1|<base64 frame>  ⇄               │  Windows: rdt-agent.ps1  │
│  (this repo, Node/TS)   │     stop-and-wait ARQ, chunked           │  (responder, PowerShell) │
│  tools: run/upload/...   │                                          │  runs cmds in your shell │
└─────────────────────────┘                                          └──────────────────────────┘
```

The link is a classic **stop-and-wait protocol**: one frame at a time, each a
full clipboard write of `RDT1|<base64(json)>`, with sequence numbers for
ordering + de-duplication and automatic retransmit if the user clobbers the
clipboard mid-exchange. Large payloads (files, screenshots) are chunked. See
`src/protocol.ts` for the full contract.

## Safety

The Windows helper (`windows/rdt-agent.ps1`) is deliberately conservative — it
runs on a sensitive machine:

- **One readable file.** No obfuscation, no encoded blobs. Read it top to bottom.
- **No network.** It never opens a socket. The clipboard is the only channel.
- **No persistence.** Runs in your console window only; Ctrl+C or closing it
  stops everything. No service, scheduled task, registry key, or startup entry.
- **Does nothing on its own.** It only runs the commands you send from the Mac —
  the same commands you'd otherwise type yourself. It runs as you, no elevation.
- **Transparent.** Every command is printed in the console before it runs.
- **Opt-in guardrails.** `-DryRun` echoes commands without running them;
  `-DenyRegex '<pattern>'` refuses commands that match.

## Setup

### 1. Build the server (on the Mac)

```bash
npm install
npm run build
```

### 2. Register it with your MCP client

**Claude Code:**

```bash
claude mcp add citrix -- node /ABSOLUTE/PATH/TO/CitrixMCP/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "citrix": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/CitrixMCP/dist/index.js"]
    }
  }
}
```

### 3. Start the helper (inside the Citrix/RDP Windows session)

There are two interchangeable helpers — both speak the identical clipboard
protocol, so the Mac server works with either. Pick whichever your locked-down
box allows.

**Option A — PowerShell** (`windows/rdt-agent.ps1`). Open **Windows PowerShell**
(`powershell.exe`, v5.1) in the remote session and run:

```powershell
.\rdt-agent.ps1 -DryRun   # safe first run: shows commands, executes nothing
.\rdt-agent.ps1           # real run
```

> **If you see "cannot be loaded because its operation is blocked by software
> restriction policies"** — that block is on the `.ps1` *file*, not on
> PowerShell. First confirm the session allows full language (must print
> `FullLanguage`):
>
> ```powershell
> $ExecutionContext.SessionState.LanguageMode
> ```
>
> If `FullLanguage`, run the code interactively instead of as a file:
>
> ```powershell
> Get-Content .\rdt-agent.ps1 -Raw | Invoke-Expression                       # real run
> & ([ScriptBlock]::Create((Get-Content .\rdt-agent.ps1 -Raw))) -DryRun      # dry run
> ```
>
> If it prints `ConstrainedLanguage`, PowerShell is locked down — use Option B.

**Option B — Python** (`windows/rdt_agent.py`). Standard library only; needs any
Python 3.6+ on the box. Commands still run through PowerShell under the hood, and
the working directory persists between commands (variables/modules do not).

```powershell
python rdt_agent.py --dry-run   # or:  py rdt_agent.py --dry-run
python rdt_agent.py             # real run
```

Leave whichever helper you chose running. Stop it anytime with **Ctrl+C**.

### 4. Verify

From the MCP client, call `rdt_ping`. You should get back the remote host name,
user, and PowerShell version. Then try `rdt_run` with `Get-Location`.

## Tools

| Tool | What it does |
|------|--------------|
| `rdt_ping` | Confirm the helper is alive; returns host/user/PowerShell version. |
| `rdt_run` | Run a PowerShell command/script in the session and return output. Working directory persists between calls. The universal tool. |
| `rdt_launch` | `Start-Process` a program (`powershell.exe`, `notepad.exe`, a path, a document); returns PID. |
| `rdt_list_windows` | List visible top-level windows as JSON `[{pid, process, title}]`. |
| `rdt_focus` | Bring a window to the foreground by PID or title substring. |
| `rdt_send_keys` | Send keystrokes (.NET SendKeys syntax, e.g. `^c`, `{F5}`) to the session, optionally activating a window first. |
| `rdt_type` | Type arbitrary literal text (special chars auto-escaped; newlines press Enter). |
| `rdt_mouse` | Move the cursor to `(x, y)` and optionally click (left/right/middle, click/double). |
| `rdt_screenshot` | Capture the remote desktop as PNG and return it as an image (optionally save locally). |
| `rdt_processes` | List top processes by memory as JSON `[{pid, name, ws_mb, cpu}]`. |
| `rdt_upload` | Send a local file or inline text into a file on the Windows box (binary-safe, chunked). |
| `rdt_download` | Pull a file off the Windows box to a local path (binary-safe, chunked). |

A typical GUI-driving loop: `rdt_screenshot` to see the desktop → `rdt_list_windows`
/ `rdt_focus` to target a window → `rdt_mouse` / `rdt_type` / `rdt_send_keys` to
act → `rdt_screenshot` again to confirm.

## Configuration

Environment variables on the **server** (Mac) side, all optional:

| Var | Default | Meaning |
|-----|---------|---------|
| `RDT_POLL_INTERVAL_MS` | `250` | Clipboard poll interval. |
| `RDT_RETRANSMIT_MS` | `2500` | Re-assert a frame if the peer goes quiet this long. |
| `RDT_FRAME_TIMEOUT_MS` | `60000` | Give up on one frame round-trip. |
| `RDT_EXEC_TIMEOUT_MS` | `120000` | Default per-command wait. |
| `RDT_CHUNK_BYTES` | `262144` | Payload bytes per frame before base64. |
| `RDT_RESTORE_CLIPBOARD` | `true` | Restore the user's clipboard after each op. |
| `RDT_DEBUG` | `false` | Verbose frame logging to stderr. |

The helper takes matching flags: `-PollMs`, `-ChunkBytes`, `-DefaultTimeoutMs`,
`-DryRun`, `-DenyRegex`, `-Quiet`.

## Limitations

- **One operation at a time.** The clipboard is a single shared cell, so ops are
  serialized. This is a control channel, not a bulk pipe.
- **Don't copy/paste while an op runs.** It transiently owns the clipboard; the
  protocol recovers from collisions but a paste mid-transfer slows things down.
- **Throughput** is bounded by clipboard sync latency × round-trips. Fine for
  configs, scripts, logs, and modest files; not for gigabytes.
- **Bootstrap is manual:** you start the helper once by hand. After that the
  agent can launch further PowerShell windows, apps, etc. via the tools.
- Use **Windows PowerShell 5.1** (`powershell.exe`), which is STA by default —
  required for clipboard and screenshot APIs.

## Testing

### Offline (no Windows / no Citrix)

```bash
npm run build                    # compile TS -> dist/
npm run selftest                 # loopback protocol test (Mac relay)
python3 scripts/selftest_py.py   # Python responder test
```

These run the real Mac-side relay against an in-process port of the Windows
responder over an in-memory clipboard, exercising ping / exec / upload /
download / screenshot with a tiny chunk size so the multi-frame paths run. The
TS and Python frame codecs are verified byte-identical, so either helper
interoperates with the server.

### Live (against the running helper)

With the helper running in the Citrix session and the clipboard synced, this
launches the built server as a real MCP client would and exercises **every
tool** end-to-end:

```bash
node scripts/test-all.mjs                 # safe: never sends input to the desktop
node scripts/test-all.mjs --interactive   # also tests keyboard input via Notepad
node scripts/test-all.mjs --shot-dir DIR  # where to save the screenshot PNG
```

Safe mode covers ping, run, list-windows, processes, launch, upload+download
round-trip, screenshot, mouse-move, and focus. The `--interactive` run adds the
keyboard tools (`rdt_type`, `rdt_send_keys`) by launching Notepad, typing into
it, and closing it without saving — it is opt-in because it sends real
keystrokes into the live session.

There are also two focused live probes: `node scripts/ping-client.mjs` (ping +
one command) and `node scripts/transfer-test.mjs` (700 KB binary round-trip with
a Windows-side hash check).

See `TODO.md` for status and remaining verification against the live session.
