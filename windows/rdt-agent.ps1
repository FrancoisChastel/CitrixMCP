<#
  rdt-agent.ps1 — Remote Desktop Terminal helper (RESPONDER side)
  Requires Windows PowerShell 5.1+ (run in powershell.exe, which is STA).

  IF RUNNING THE FILE IS BLOCKED by Software Restriction Policy / execution
  policy ("cannot be loaded because its operation is blocked..."), run the code
  interactively instead — the block is on the *file*, not on PowerShell:

      Get-Content .\rdt-agent.ps1 -Raw | Invoke-Expression

  First confirm the session allows full language (must print "FullLanguage"):

      $ExecutionContext.SessionState.LanguageMode

  If it prints "ConstrainedLanguage", use the Python helper (rdt_agent.py).

  WHAT THIS IS
    A small, self-contained relay you run inside your Windows PowerShell session.
    It watches the Windows clipboard for command "frames" that the Mac MCP server
    puts there (Citrix keeps the clipboard synced between the two machines),
    executes them in THIS session, and writes the results back to the clipboard.

  SAFETY (read before running)
    - It ONLY reacts to clipboard values that start with the marker "RDT1|".
      Normal copy/paste is ignored.
    - It does nothing on its own. It only runs the commands YOU send from your
      Mac — exactly the commands you would otherwise type here yourself.
    - No network. It never opens a socket. The only channel is the clipboard.
    - No persistence. It runs in this console window only. Press Ctrl+C or close
      the window to stop it completely. It installs no service, task, or startup
      entry and writes nothing to the registry.
    - It runs as you, with your privileges. No elevation.
    - Every command it runs is printed here first, so you can watch and Ctrl+C.

  OPTIONS
    -DryRun        Print commands but do NOT execute them (safe first test).
    -DenyRegex     Refuse any command matching this regex (opt-in guardrail).
    -Quiet         Suppress the per-command log.
    -PollMs        Clipboard poll interval (default 250).
    -ChunkBytes    Max payload bytes per frame before base64 (default 262144).
    -DefaultTimeoutMs  Per-command timeout when the caller doesn't set one.

  USAGE
    Open Windows PowerShell (powershell.exe, v5.1) in the RDP session, then:
      .\rdt-agent.ps1
    Leave it running. Stop with Ctrl+C.
#>

[CmdletBinding()]
param(
  [int]$PollMs = 250,
  [int]$ChunkBytes = 262144,
  [int]$DefaultTimeoutMs = 120000,
  [int]$ResendMs = 1500,
  [switch]$DryRun,
  [string]$DenyRegex = '',
  [switch]$Quiet,
  [switch]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RDT_VERSION = '0.2.0'
$FRAME_PREFIX = 'RDT1|'
$PROTO_V = 1

if ($Version) {
  Write-Host "rdt-agent.ps1 version $RDT_VERSION (protocol v$PROTO_V)"
  exit 0
}

# --- session state -----------------------------------------------------------
$script:CurrentSid = $null
$script:LastSeenN = 0
$script:LastReply = $null
$script:LastResend = 0
$script:Out = $null            # active outbound stream (exec/get/shot)
$script:PutStream = $null      # active inbound file (put)
$script:PutWritten = 0
$script:PutGzip = $false
$script:PutFinal = $null
$script:PutTemp = $null
$script:ExecRunspace = $null

function Log($msg) {
  if (-not $Quiet) {
    Write-Host ('[rdt {0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg) -ForegroundColor DarkCyan
  }
}

# --- framing -----------------------------------------------------------------
function Encode-Frame($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return $FRAME_PREFIX + [Convert]::ToBase64String($bytes)
}

function Decode-Frame($raw) {
  if (-not $raw) { return $null }
  $t = ([string]$raw).Trim()
  if (-not $t.StartsWith($FRAME_PREFIX)) { return $null }
  try {
    $b64 = $t.Substring($FRAME_PREFIX.Length)
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
    $o = $json | ConvertFrom-Json
    if ($o.v -ne $PROTO_V) { return $null }
    return $o
  } catch { return $null }
}

function New-Reply {
  param($n, [string]$op, $data = $null, $seq = $null, $total = $null, [bool]$fin = $false)
  $obj = [ordered]@{ v = $PROTO_V; sid = $script:CurrentSid; n = $n; role = 'w'; op = $op }
  if ($null -ne $seq)   { $obj.seq = $seq }
  if ($null -ne $total) { $obj.total = $total }
  if ($fin)             { $obj.fin = $true }
  if ($null -ne $data)  { $obj.data = $data }
  return Encode-Frame $obj
}

function New-Error($n, [string]$message) {
  return New-Reply -n ($n + 1) -op 'err' -fin $true -data @{ message = $message }
}

# --- outbound stream (exec / get / shot replies) -----------------------------
# The reply is streamed from a .NET Stream, reading the next chunk on demand so a
# multi-GB file never sits in memory. exec/shot wrap their bytes in a
# MemoryStream; get opens a FileStream (optionally over a gzip temp).
function Start-OutStream([System.IO.Stream]$stream, [long]$length, $meta, [string]$op, [string]$temp) {
  $total = [int][Math]::Max(1, [Math]::Ceiling($length / $ChunkBytes))
  $script:Out = @{ Stream = $stream; Length = $length; Total = $total; Meta = $meta; Op = $op; Temp = $temp; SeqNext = 1 }
}

function Close-OutStream {
  if ($script:Out) {
    try { $script:Out.Stream.Dispose() } catch {}
    if ($script:Out.Temp) { Remove-Item -LiteralPath $script:Out.Temp -Force -ErrorAction SilentlyContinue }
    $script:Out = $null
  }
}

function Emit-Chunk($incomingN, [int]$seq) {
  $buf = New-Object byte[] $ChunkBytes
  $read = $script:Out.Stream.Read($buf, 0, $ChunkBytes)
  $fin = ($script:Out.Stream.Position -ge $script:Out.Length)
  if ($read -le 0) { $b64 = '' }
  elseif ($read -eq $ChunkBytes) { $b64 = [Convert]::ToBase64String($buf) }
  else {
    $slice = New-Object byte[] $read
    [Array]::Copy($buf, 0, $slice, 0, $read)
    $b64 = [Convert]::ToBase64String($slice)
  }
  $data = @{ chunk = $b64 }
  if ($fin -and $script:Out.Meta) { $data.meta = $script:Out.Meta }
  $reply = New-Reply -n ($incomingN + 1) -op $script:Out.Op -seq $seq -total $script:Out.Total -fin $fin -data $data
  if ($fin) { Close-OutStream }
  return $reply
}

# --- command execution (persistent session state, hard timeout) --------------
function Invoke-UserCommand([string]$cmd, [int]$timeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ps = [powershell]::Create()
  $ps.Runspace = $script:ExecRunspace
  # Merge every stream to text so errors show inline, like an interactive console.
  $wrapped = "& {`n$cmd`n} 2>&1 | Out-String -Width 4096"
  [void]$ps.AddScript($wrapped)
  $async = $ps.BeginInvoke()
  $done = $async.AsyncWaitHandle.WaitOne($timeoutMs)
  $truncated = $false
  $textOut = ''
  if ($done) {
    try { $result = $ps.EndInvoke($async); $textOut = ($result -join '') }
    catch { $textOut = ($_ | Out-String) }
  } else {
    try { $ps.Stop() } catch {}
    $truncated = $true
    $textOut = "[rdt] command exceeded ${timeoutMs}ms and was stopped.`n"
  }
  $exit = $null
  try { $exit = $script:ExecRunspace.SessionStateProxy.GetVariable('LASTEXITCODE') } catch {}
  $ps.Dispose()
  $sw.Stop()
  return @{ text = $textOut; exit = $exit; durationMs = [int]$sw.ElapsedMilliseconds; truncated = $truncated }
}

function Get-ScreenPng {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  try {
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($vs.X, $vs.Y, 0, 0, $vs.Size)
    $gfx.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
  } finally {
    $bmp.Dispose()
  }
}

# --- request dispatch --------------------------------------------------------
function Process-Frame($frame) {
  switch ($frame.op) {
    'ping' {
      $data = @{
        version    = $PROTO_V
        host       = $env:COMPUTERNAME
        user       = $env:USERNAME
        pid          = $PID
        powershell   = $PSVersionTable.PSVersion.ToString()
        agentVersion = $RDT_VERSION
        gzip         = $true
      }
      return New-Reply -n ($frame.n + 1) -op 'ping' -fin $true -data $data
    }
    'exec' {
      $cmd = [string]$frame.data.cmd
      $to = $DefaultTimeoutMs
      if ($frame.data.PSObject.Properties.Name -contains 'timeoutMs' -and $frame.data.timeoutMs) {
        $to = [int]$frame.data.timeoutMs
      }
      Log ("exec: " + $cmd)
      if ($DenyRegex -and ($cmd -match $DenyRegex)) {
        return New-Error $frame.n 'command blocked by -DenyRegex'
      }
      if ($DryRun) {
        $r = @{ text = "[dry-run] would run:`n$cmd`n"; exit = $null; durationMs = 0; truncated = $false }
      } else {
        $r = Invoke-UserCommand $cmd $to
      }
      $meta = @{ exitCode = $r.exit; durationMs = $r.durationMs; truncated = $r.truncated }
      $bytes = [Text.Encoding]::UTF8.GetBytes($r.text)
      Start-OutStream (New-Object System.IO.MemoryStream(, $bytes)) $bytes.Length $meta 'exec' $null
      return Emit-Chunk $frame.n 0
    }
    'get' {
      $path = [string]$frame.data.path
      $gz = [bool]$frame.data.gzip
      Log ("get: " + $path + $(if ($gz) { ' (gzip)' } else { '' }))
      try {
        if ($gz) {
          $temp = $path + '.rdtdown'
          $inFs = [System.IO.File]::OpenRead($path)
          $outFs = [System.IO.File]::Create($temp)
          $gzs = New-Object System.IO.Compression.GZipStream($outFs, [System.IO.Compression.CompressionMode]::Compress)
          $inFs.CopyTo($gzs)
          $gzs.Dispose(); $outFs.Dispose(); $inFs.Dispose()
          $stream = [System.IO.File]::OpenRead($temp)
          Start-OutStream $stream $stream.Length $null 'get' $temp
        } else {
          $stream = [System.IO.File]::OpenRead($path)
          Start-OutStream $stream $stream.Length $null 'get' $null
        }
      } catch { return New-Error $frame.n ("read failed: " + $_.Exception.Message) }
      return Emit-Chunk $frame.n 0
    }
    'shot' {
      Log 'screenshot'
      try { $bytes = Get-ScreenPng }
      catch { return New-Error $frame.n ("screenshot failed: " + $_.Exception.Message) }
      Start-OutStream (New-Object System.IO.MemoryStream(, $bytes)) $bytes.Length $null 'shot' $null
      return Emit-Chunk $frame.n 0
    }
    'put' {
      if ($frame.seq -eq 0) {
        $path = [string]$frame.data.path
        $ov = [bool]$frame.data.overwrite
        $script:PutGzip = [bool]$frame.data.gzip
        $script:PutFinal = $path
        Log ("put: " + $path + $(if ($script:PutGzip) { ' (gzip)' } else { '' }))
        if ((Test-Path -LiteralPath $path) -and -not $ov) {
          return New-Error $frame.n 'file exists and overwrite is false'
        }
        try {
          $target = if ($script:PutGzip) { $path + '.rdtpart' } else { $path }
          $script:PutTemp = if ($script:PutGzip) { $target } else { $null }
          $script:PutStream = [IO.File]::Open($target, 'Create', 'Write')
          $script:PutWritten = 0
        }
        catch { return New-Error $frame.n ("open failed: " + $_.Exception.Message) }
        return New-Reply -n ($frame.n + 1) -op 'ack' -data @{ ready = $true }
      }
      if (-not $script:PutStream) { return New-Error $frame.n 'no active upload' }
      try {
        $b = [Convert]::FromBase64String([string]$frame.data.chunk)
        $script:PutStream.Write($b, 0, $b.Length)
        $script:PutWritten += $b.Length
      } catch { return New-Error $frame.n ("write failed: " + $_.Exception.Message) }
      if ($frame.fin) {
        $script:PutStream.Close(); $script:PutStream = $null
        try {
          if ($script:PutGzip) {
            $inFs = [System.IO.File]::OpenRead($script:PutTemp)
            $gzs = New-Object System.IO.Compression.GZipStream($inFs, [System.IO.Compression.CompressionMode]::Decompress)
            $outFs = [System.IO.File]::Create($script:PutFinal)
            $gzs.CopyTo($outFs)
            $outFs.Dispose(); $gzs.Dispose(); $inFs.Dispose()
            Remove-Item -LiteralPath $script:PutTemp -Force -ErrorAction SilentlyContinue
            $script:PutTemp = $null
            $written = (Get-Item -LiteralPath $script:PutFinal).Length
          } else {
            $written = $script:PutWritten
          }
        } catch { return New-Error $frame.n ("finalize failed: " + $_.Exception.Message) }
        return New-Reply -n ($frame.n + 1) -op 'ack' -fin $true -data @{ ok = $true; bytesWritten = $written }
      }
      return New-Reply -n ($frame.n + 1) -op 'ack' -data @{ seq = $frame.seq }
    }
    'ack' {
      if (-not $script:Out) { return New-Error $frame.n 'unexpected ack' }
      $seq = [int]$script:Out.SeqNext
      $script:Out.SeqNext = $seq + 1
      return Emit-Chunk $frame.n $seq
    }
    default { return New-Error $frame.n ("unknown op: " + $frame.op) }
  }
}

function Reset-Transfer {
  if ($script:PutStream) { try { $script:PutStream.Close() } catch {} ; $script:PutStream = $null }
  if ($script:PutTemp) { Remove-Item -LiteralPath $script:PutTemp -Force -ErrorAction SilentlyContinue; $script:PutTemp = $null }
  Close-OutStream
}

# --- startup -----------------------------------------------------------------
$apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState()
if ($apartment -ne 'STA') {
  Write-Host "[rdt] WARNING: not running in STA mode; clipboard/screenshot may fail." -ForegroundColor Yellow
  Write-Host "[rdt] Start with:  powershell.exe -STA -File .\rdt-agent.ps1" -ForegroundColor Yellow
}

$script:ExecRunspace = [runspacefactory]::CreateRunspace()
$script:ExecRunspace.ApartmentState = 'STA'
$script:ExecRunspace.ThreadOptions = 'ReuseThread'
$script:ExecRunspace.Open()

Write-Host ""
Write-Host "  Remote Desktop Terminal helper  v$RDT_VERSION  (protocol v$PROTO_V)" -ForegroundColor Cyan
Write-Host "  host=$env:COMPUTERNAME user=$env:USERNAME pid=$PID ps=$($PSVersionTable.PSVersion)" -ForegroundColor Gray
Write-Host "  Watching clipboard. Every command is printed before it runs." -ForegroundColor Gray
if ($DryRun) { Write-Host "  DRY RUN: commands are shown but NOT executed." -ForegroundColor Yellow }
if ($DenyRegex) { Write-Host "  Deny filter active: $DenyRegex" -ForegroundColor Yellow }
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

try {
  while ($true) {
    Start-Sleep -Milliseconds $PollMs
    try { $raw = Get-Clipboard -Raw -ErrorAction Stop } catch { continue }
    $frame = Decode-Frame $raw
    if ($null -eq $frame) { continue }
    if ($frame.role -ne 'm') { continue }

    if ($frame.sid -ne $script:CurrentSid) {
      $script:CurrentSid = $frame.sid
      $script:LastSeenN = 0
      Reset-Transfer
      Log ("session " + $frame.sid)
    }

    if ($frame.n -gt $script:LastSeenN) {
      $script:LastSeenN = $frame.n
      try { $reply = Process-Frame $frame }
      catch { $reply = New-Error $frame.n $_.Exception.Message }
      $script:LastReply = $reply
      Set-Clipboard -Value $reply
      $script:LastResend = [Environment]::TickCount
    }
    else {
      $tick = [Environment]::TickCount
      if ($script:LastReply -and (($tick - $script:LastResend) -gt $ResendMs)) {
        Set-Clipboard -Value $script:LastReply
        $script:LastResend = $tick
      }
    }
  }
}
finally {
  Reset-Transfer
  if ($script:ExecRunspace) { try { $script:ExecRunspace.Close() } catch {} }
  Write-Host "`n[rdt] stopped." -ForegroundColor Cyan
}
