/**
 * Pure builders that turn structured tool arguments into PowerShell snippets.
 * Kept separate from the MCP wiring so they can be unit-tested and audited on
 * their own. Every value that reaches PowerShell goes through psSingleQuote so a
 * path or title containing a quote cannot break out of its string literal.
 */

/** Escape a value for use inside a single-quoted PowerShell string. */
export function psSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export interface LaunchArgs {
  program: string;
  args?: string;
  workingDirectory?: string;
}

/**
 * Launch a program in the Windows session and report its PID. Uses -PassThru so
 * we can echo the process id back to the caller.
 */
export function buildLaunch({
  program,
  args,
  workingDirectory,
}: LaunchArgs): string {
  const parts = [
    "$ErrorActionPreference='Stop';",
    "$p = Start-Process -PassThru -FilePath",
    psSingleQuote(program),
  ];
  if (args && args.trim() !== "") {
    parts.push("-ArgumentList", psSingleQuote(args));
  }
  if (workingDirectory && workingDirectory.trim() !== "") {
    parts.push("-WorkingDirectory", psSingleQuote(workingDirectory));
  }
  parts.push(
    ";",
    "Write-Output ('Launched ' + $p.Name + ' (PID ' + $p.Id + ')')",
  );
  return parts.join(" ");
}

export interface SendKeysArgs {
  keys: string;
  windowTitle?: string;
  delayMs?: number;
}

/**
 * Send keystrokes to the Windows session. Optionally activates a window first
 * by title. `keys` uses .NET SendKeys syntax, e.g. "hello{ENTER}" or "^c".
 */
export function buildSendKeys({
  keys,
  windowTitle,
  delayMs = 300,
}: SendKeysArgs): string {
  const lines = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Windows.Forms;",
  ];
  if (windowTitle && windowTitle.trim() !== "") {
    lines.push(
      "$wsh = New-Object -ComObject WScript.Shell;",
      `$ok = $wsh.AppActivate(${psSingleQuote(windowTitle)});`,
      `Start-Sleep -Milliseconds ${Math.max(0, Math.floor(delayMs))};`,
      "if (-not $ok) { Write-Output 'warning: could not activate window; sending to foreground' };",
    );
  }
  lines.push(
    `[System.Windows.Forms.SendKeys]::SendWait(${psSingleQuote(keys)});`,
    "Write-Output 'keys sent'",
  );
  return lines.join(" ");
}

/**
 * Build a snippet that writes a UTF-8 string to a file. Only used for the small
 * text path; binary/large uploads go through the chunked `put` transfer.
 */
export function buildWriteTextFile(path: string, contentBase64: string): string {
  return [
    "$ErrorActionPreference='Stop';",
    `$bytes = [Convert]::FromBase64String(${psSingleQuote(contentBase64)});`,
    `[IO.File]::WriteAllBytes(${psSingleQuote(path)}, $bytes);`,
    `Write-Output ('wrote ' + $bytes.Length + ' bytes')`,
  ].join(" ");
}

/**
 * List visible top-level windows as a JSON array of {pid, process, title}.
 * The count guards keep the output a valid array even for 0 or 1 windows,
 * which ConvertTo-Json would otherwise collapse.
 */
export function buildListWindows(): string {
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "$arr = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |",
    "  Select-Object @{n='pid';e={$_.Id}}, @{n='process';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}} |",
    "  Sort-Object process);",
    "if ($arr.Count -eq 0) { '[]' }",
    "elseif ($arr.Count -eq 1) { '[' + ($arr[0] | ConvertTo-Json -Compress) + ']' }",
    "else { $arr | ConvertTo-Json -Compress }",
  ].join(" ");
}

export interface FocusArgs {
  title?: string;
  pid?: number;
}

/** Bring a window to the foreground by PID (preferred) or title substring. */
export function buildFocus({ title, pid }: FocusArgs): string {
  const activate =
    pid !== undefined
      ? `$ok = $wsh.AppActivate([int]${Math.trunc(pid)});`
      : `$ok = $wsh.AppActivate(${psSingleQuote(title ?? "")});`;
  return [
    "$wsh = New-Object -ComObject WScript.Shell;",
    activate,
    "Start-Sleep -Milliseconds 200;",
    "if ($ok) { 'activated' } else { 'window not found' }",
  ].join(" ");
}

export type MouseButton = "left" | "right" | "middle";
export type MouseAction = "move" | "click" | "double";

export interface MouseArgs {
  x: number;
  y: number;
  button?: MouseButton;
  action?: MouseAction;
}

/**
 * Move the cursor and optionally click, via a tiny P/Invoke shim. The shim is
 * added once per session (guarded so a second call doesn't re-add the type).
 */
export function buildMouse({ x, y, button = "left", action = "click" }: MouseArgs): string {
  const flags: Record<MouseButton, [number, number]> = {
    left: [0x02, 0x04],
    right: [0x08, 0x10],
    middle: [0x20, 0x40],
  };
  const [down, up] = flags[button];
  const lines = [
    "$ErrorActionPreference='Stop';",
    "if (-not ('RdtMouse' -as [type])) { Add-Type @\"",
    "using System; using System.Runtime.InteropServices;",
    "public class RdtMouse {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);",
    "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);",
    "}",
    "\"@ }",
    `[RdtMouse]::SetCursorPos(${Math.trunc(x)}, ${Math.trunc(y)}) | Out-Null;`,
  ];
  if (action !== "move") {
    const clicks = action === "double" ? 2 : 1;
    for (let i = 0; i < clicks; i++) {
      lines.push(
        `[RdtMouse]::mouse_event(${down},0,0,0,[IntPtr]::Zero); [RdtMouse]::mouse_event(${up},0,0,0,[IntPtr]::Zero);`,
      );
    }
  }
  lines.push("'ok'");
  return lines.join("\n");
}

/** Top processes by working set, as JSON [{pid,name,ws_mb,cpu}]. */
export function buildProcesses(top: number): string {
  const n = Math.max(1, Math.min(200, Math.trunc(top) || 20));
  return [
    "$arr = @(Get-Process | Sort-Object -Descending WS |",
    `  Select-Object -First ${n} @{n='pid';e={$_.Id}}, @{n='name';e={$_.ProcessName}},`,
    "    @{n='ws_mb';e={[math]::Round($_.WS/1MB,1)}}, @{n='cpu';e={$_.CPU}});",
    "if ($arr.Count -eq 1) { '[' + ($arr[0] | ConvertTo-Json -Compress) + ']' }",
    "else { $arr | ConvertTo-Json -Compress }",
  ].join(" ");
}

/**
 * Escape arbitrary text so .NET SendKeys types it literally: the metacharacters
 * + ^ % ~ ( ) [ ] { } are each wrapped in braces, and newlines/tabs become the
 * {ENTER}/{TAB} tokens SendKeys understands.
 */
export function escapeSendKeys(text: string): string {
  return text
    .replace(/[+^%~(){}\[\]]/g, (m) => `{${m}}`)
    .replace(/\r\n|\r|\n/g, "{ENTER}")
    .replace(/\t/g, "{TAB}");
}
