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
