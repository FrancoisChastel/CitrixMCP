/**
 * MCP tool surface. Every tool ultimately rides the clipboard relay. The two
 * primitives the Windows helper implements are exec (run PowerShell) and the
 * chunked transfers (put/get/shot); the richer tools here are ergonomic
 * wrappers that build the right PowerShell so callers do not have to.
 */

import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Relay, ExecResult } from "./relay.js";
import { APP_VERSION, PROTOCOL_VERSION, config } from "./config.js";
import {
  buildFocus,
  buildLaunch,
  buildListWindows,
  buildMouse,
  buildProcesses,
  buildSendKeys,
  escapeSendKeys,
} from "./psbuilders.js";
import { log } from "./util.js";

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (body: string, isError = false): TextResult => ({
  content: [{ type: "text", text: body }],
  isError,
});

function formatExec(result: ExecResult): string {
  const lines: string[] = [];
  lines.push(result.output.trimEnd() || "(no output)");
  lines.push("");
  lines.push(
    `— exit code: ${result.exitCode ?? "n/a"} · ${result.durationMs}ms${
      result.truncated ? " · TIMED OUT (partial output; command may still be running on Windows)" : ""
    }`,
  );
  return lines.join("\n");
}

async function guarded(
  fn: () => Promise<TextResult>,
): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `tool failed: ${msg}`);
    return text(`Error: ${msg}`, true);
  }
}

export function registerTools(server: McpServer, relay: Relay): void {
  server.registerTool(
    "rdt_ping",
    {
      title: "Ping remote helper",
      description:
        "Check that the Windows helper is running and the clipboard link is alive. Returns server/helper versions, host, user, PowerShell version, and gzip support. Run this first.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const info = await relay.ping();
        return text(
          `Helper is alive.\n` +
            `server: CitrixMCP v${APP_VERSION} (protocol v${PROTOCOL_VERSION})\n` +
            `helper: v${info.agentVersion ?? "pre-0.2"}${info.gzip ? " (gzip)" : ""}\n` +
            `host: ${info.host}\nuser: ${info.user}\npid: ${info.pid}\n` +
            `powershell: ${info.powershell}\nprotocol: v${info.version}`,
        );
      }),
  );

  server.registerTool(
    "rdt_run",
    {
      title: "Run PowerShell",
      description:
        "Run a PowerShell command or script in the persistent remote session and return its merged output (stdout + errors). Session state (current directory, variables, imported modules) persists between calls. This is the universal control tool — anything PowerShell can do on the box, you can do here.",
      inputSchema: {
        command: z.string().min(1).describe("PowerShell command or script to run."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Max time to wait for completion before returning partial output (default ${config.execTimeoutMs}ms).`,
          ),
      },
    },
    async ({ command, timeoutMs }) =>
      guarded(async () => {
        const result = await relay.exec(command, timeoutMs ?? config.execTimeoutMs);
        return text(formatExec(result), result.truncated);
      }),
  );

  server.registerTool(
    "rdt_launch",
    {
      title: "Launch a program",
      description:
        "Start a program in the Windows session (e.g. 'powershell.exe', 'notepad.exe', 'explorer.exe', a full path, or a document). Returns the launched process name and PID.",
      inputSchema: {
        program: z
          .string()
          .min(1)
          .describe("Executable, command, or file to launch, e.g. 'powershell.exe'."),
        args: z.string().optional().describe("Command-line arguments, as one string."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory to start the process in."),
      },
    },
    async ({ program, args, workingDirectory }) =>
      guarded(async () => {
        const cmd = buildLaunch({ program, args, workingDirectory });
        const result = await relay.exec(cmd, 30_000);
        return text(formatExec(result), result.exitCode !== 0 && result.exitCode !== null);
      }),
  );

  server.registerTool(
    "rdt_send_keys",
    {
      title: "Send keystrokes",
      description:
        "Send keystrokes to the Windows session using .NET SendKeys syntax (e.g. 'hello{ENTER}', '^c' for Ctrl+C, '%{F4}' for Alt+F4). Optionally activate a window by title first. Use this to drive GUI apps or a foreground console.",
      inputSchema: {
        keys: z.string().min(1).describe("Keys in SendKeys syntax."),
        windowTitle: z
          .string()
          .optional()
          .describe("If set, activate the window whose title contains this text first."),
        delayMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Pause after activating the window before typing (default 300ms)."),
      },
    },
    async ({ keys, windowTitle, delayMs }) =>
      guarded(async () => {
        const cmd = buildSendKeys({ keys, windowTitle, delayMs });
        const result = await relay.exec(cmd, 30_000);
        return text(formatExec(result));
      }),
  );

  server.registerTool(
    "rdt_screenshot",
    {
      title: "Screenshot remote desktop",
      description:
        "Capture the Windows session desktop as a PNG and return it as an image so you can see the current state of the remote instance. Optionally also saves the PNG to a local file on the Mac.",
      inputSchema: {
        savePath: z
          .string()
          .optional()
          .describe("Optional local Mac path to also save the PNG to."),
      },
    },
    async ({ savePath }) => {
      try {
        const png = await relay.screenshot();
        const content: (
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        )[] = [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ];
        if (savePath) {
          const abs = resolve(savePath);
          await writeFile(abs, png);
          content.push({ type: "text", text: `Saved ${png.length} bytes to ${abs}` });
        }
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", `screenshot failed: ${msg}`);
        return text(`Error: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    "rdt_upload",
    {
      title: "Upload file/data to Windows",
      description:
        "Send data from the Mac into a file in the Windows session. Provide either a local Mac file path (binary-safe, streamed from disk, gzip-compressed by default) or inline text content. For large files prefer localPath.",
      inputSchema: {
        remotePath: z
          .string()
          .min(1)
          .describe("Destination path on the Windows box, e.g. 'C:\\\\Users\\\\me\\\\out.bin'."),
        localPath: z.string().optional().describe("Local Mac file to read and upload (streamed)."),
        content: z
          .string()
          .optional()
          .describe("Inline UTF-8 text to write (alternative to localPath; not compressed)."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Overwrite if the file exists (default true)."),
        compress: z
          .boolean()
          .optional()
          .describe("Gzip the file in transit (default true; ignored for inline content)."),
      },
    },
    async ({ remotePath, localPath, content, overwrite, compress }) =>
      guarded(async () => {
        if (!localPath && content === undefined) {
          return text("Error: provide either localPath or content.", true);
        }
        if (localPath) {
          const res = await relay.putFileFromDisk(remotePath, resolve(localPath), {
            overwrite: overwrite ?? true,
            gzip: compress ?? true,
          });
          const note = res.compressed
            ? ` (gzip: ${fmtBytes(res.wireBytes)} on the wire, ${pct(res.wireBytes, res.bytesWritten)} of original)`
            : "";
          return text(
            `Uploaded ${fmtBytes(res.bytesWritten)} to ${remotePath} from ${basename(localPath)}${note}`,
          );
        }
        const data = Buffer.from(content ?? "", "utf8");
        const res = await relay.putFile(remotePath, data, overwrite ?? true);
        return text(`Uploaded ${res.bytesWritten} bytes to ${remotePath}`);
      }),
  );

  server.registerTool(
    "rdt_download",
    {
      title: "Download file from Windows",
      description:
        "Read a file out of the Windows session and save it to a local Mac path. Binary-safe, streamed straight to disk (safe for multi-GB files), gzip-compressed in transit by default.",
      inputSchema: {
        remotePath: z
          .string()
          .min(1)
          .describe("Source file path on the Windows box."),
        localPath: z
          .string()
          .min(1)
          .describe("Local Mac path to save the downloaded file to."),
        compress: z
          .boolean()
          .optional()
          .describe("Gzip in transit — helper compresses, Mac decompresses (default true)."),
      },
    },
    async ({ remotePath, localPath, compress }) =>
      guarded(async () => {
        const abs = resolve(localPath);
        const res = await relay.getFileToDisk(remotePath, abs, { gzip: compress ?? true });
        const note = res.compressed ? ` (gzip: ${fmtBytes(res.wireBytes)} on the wire)` : "";
        return text(`Downloaded ${fmtBytes(res.bytesReceived)} from ${remotePath} to ${abs}${note}`);
      }),
  );

  server.registerTool(
    "rdt_list_windows",
    {
      title: "List open windows",
      description:
        "List the visible top-level windows in the Windows session as JSON [{pid, process, title}]. Use this to find a window to focus, type into, or screenshot.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const res = await relay.exec(buildListWindows(), 20_000);
        return text(res.output.trim() || "[]");
      }),
  );

  server.registerTool(
    "rdt_focus",
    {
      title: "Focus a window",
      description:
        "Bring a window to the foreground by PID (preferred) or by a leading substring of its title. Pair with rdt_list_windows, then rdt_send_keys / rdt_type.",
      inputSchema: {
        pid: z.number().int().positive().optional().describe("Process id of the window to activate."),
        title: z.string().optional().describe("Leading substring of the window title to activate."),
      },
    },
    async ({ pid, title }) =>
      guarded(async () => {
        if (pid === undefined && (title === undefined || title === "")) {
          return text("Error: provide pid or title.", true);
        }
        const res = await relay.exec(buildFocus({ pid, title }), 15_000);
        return text(res.output.trim());
      }),
  );

  server.registerTool(
    "rdt_type",
    {
      title: "Type literal text",
      description:
        "Type arbitrary literal text into the Windows session (special characters are auto-escaped; newlines press Enter). Optionally activate a window by title first. For key combos like Ctrl+C use rdt_send_keys instead.",
      inputSchema: {
        text: z.string().min(1).describe("Literal text to type."),
        windowTitle: z.string().optional().describe("If set, activate this window before typing."),
        delayMs: z.number().int().nonnegative().optional().describe("Pause after activating (default 300ms)."),
      },
    },
    async ({ text: body, windowTitle, delayMs }) =>
      guarded(async () => {
        const cmd = buildSendKeys({ keys: escapeSendKeys(body), windowTitle, delayMs });
        const res = await relay.exec(cmd, 30_000);
        return text(res.output.trim());
      }),
  );

  server.registerTool(
    "rdt_mouse",
    {
      title: "Move/click the mouse",
      description:
        "Move the cursor to (x, y) in the Windows session and optionally click. Combine with rdt_screenshot to see coordinates first. Buttons: left/right/middle. Actions: move/click/double.",
      inputSchema: {
        x: z.number().int().describe("Screen X coordinate."),
        y: z.number().int().describe("Screen Y coordinate."),
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)."),
        action: z.enum(["move", "click", "double"]).optional().describe("What to do (default click)."),
      },
    },
    async ({ x, y, button, action }) =>
      guarded(async () => {
        const res = await relay.exec(buildMouse({ x, y, button, action }), 15_000);
        return text(res.output.trim() || "ok");
      }),
  );

  server.registerTool(
    "rdt_processes",
    {
      title: "List processes",
      description:
        "List the top processes by memory in the Windows session as JSON [{pid, name, ws_mb, cpu}].",
      inputSchema: {
        top: z.number().int().positive().optional().describe("How many to return (default 20, max 200)."),
      },
    },
    async ({ top }) =>
      guarded(async () => {
        const res = await relay.exec(buildProcesses(top ?? 20), 20_000);
        return text(res.output.trim() || "[]");
      }),
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "n/a";
  return `${((part / whole) * 100).toFixed(0)}%`;
}
