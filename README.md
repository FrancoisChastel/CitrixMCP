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

Open **Windows PowerShell** (`powershell.exe`, v5.1) in the remote session, copy
`windows/rdt-agent.ps1` into it (paste the file, or paste its contents), and run:

```powershell
# safe first run — shows commands but does not execute them
.\rdt-agent.ps1 -DryRun

# real run
.\rdt-agent.ps1
```

Leave it running. Stop it anytime with **Ctrl+C**.

### 4. Verify

From the MCP client, call `rdt_ping`. You should get back the remote host name,
user, and PowerShell version. Then try `rdt_run` with `Get-Location`.

## Tools

| Tool | What it does |
|------|--------------|
| `rdt_ping` | Confirm the helper is alive; returns host/user/PowerShell version. |
| `rdt_run` | Run a PowerShell command/script in the **persistent** session (cwd, variables, modules persist). The universal tool. |
| `rdt_launch` | `Start-Process` a program (`powershell.exe`, `notepad.exe`, a path, a document); returns PID. |
| `rdt_send_keys` | Send keystrokes (.NET SendKeys syntax) to the session, optionally activating a window by title first. |
| `rdt_screenshot` | Capture the remote desktop as PNG and return it as an image (optionally save locally). |
| `rdt_upload` | Send a local file or inline text into a file on the Windows box (binary-safe, chunked). |
| `rdt_download` | Pull a file off the Windows box to a local path (binary-safe, chunked). |

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

## Development

```bash
npm run build      # compile TS -> dist/
npm run selftest   # loopback protocol test, no Windows needed
```

The self-test runs the real Mac-side relay against an in-process port of the
Windows responder over an in-memory clipboard, exercising ping / exec / upload /
download / screenshot with a tiny chunk size so the multi-frame paths run.

See `TODO.md` for status and remaining verification against the live session.
