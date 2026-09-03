/**
 * Probe the Windows session for redirected drives / client-side shares that
 * could carry large files (Citrix Client Drive Mapping or RDP drive
 * redirection), bypassing the clipboard. Read-only enumeration.
 */

process.env.RDT_FRAME_TIMEOUT_MS ||= "30000";

const { MacClipboard } = await import("../dist/clipboard.js");
const { Relay } = await import("../dist/relay.js");
const { config } = await import("../dist/config.js");

const relay = new Relay(new MacClipboard(), config);

// One command, one round-trip: prints a labelled report.
const cmd = String.raw`
$out = New-Object System.Collections.ArrayList
[void]$out.Add('== context ==')
[void]$out.Add('MachineName = ' + [System.Environment]::MachineName)
[void]$out.Add('CLIENTNAME  = ' + $env:CLIENTNAME)
[void]$out.Add('SESSIONNAME = ' + $env:SESSIONNAME)
[void]$out.Add('')
[void]$out.Add('== logical disks (DriveType 2=removable 3=local 4=network 5=cd) ==')
[void]$out.Add((Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,ProviderName,VolumeName,@{n='GB';e={[math]::Round($_.Size/1GB,1)}} | Format-Table -AutoSize | Out-String))
[void]$out.Add('== net use ==')
[void]$out.Add((cmd /c net use 2>&1 | Out-String))
[void]$out.Add('== \\Client\ (Citrix CDM) ==')
[void]$out.Add('list: ' + (((Get-ChildItem '\\Client\' -ErrorAction SilentlyContinue | Select-Object -Expand Name) -join ', ')))
foreach ($p in '\\Client\C$','\\Client\D$','\\Client\E$','\\Client\H$') { [void]$out.Add($p + ' -> ' + (Test-Path $p)) }
[void]$out.Add('== \\tsclient\ (RDP redirection) ==')
[void]$out.Add('list: ' + (((Get-ChildItem '\\tsclient\' -ErrorAction SilentlyContinue | Select-Object -Expand Name) -join ', ')))
foreach ($p in '\\tsclient\C','\\tsclient\D','\\tsclient\E','\\tsclient\H') { [void]$out.Add($p + ' -> ' + (Test-Path $p)) }
$out -join [char]10
`;

try {
  console.log("Probing redirected drives on the Windows box...\n");
  const res = await relay.exec(cmd, 25000);
  console.log(res.output);
  console.log(`\n(exit ${res.exitCode}, ${res.durationMs}ms)`);
  process.exit(0);
} catch (err) {
  console.error("❌ " + (err instanceof Error ? err.message : String(err)));
  console.error("Is the helper still running in the Citrix session?");
  process.exit(1);
}
