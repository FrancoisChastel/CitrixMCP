#!/usr/bin/env python3
"""
rdt_agent.py - Remote Desktop Terminal helper (RESPONDER side), Python edition.

Use this when the PowerShell helper (rdt-agent.ps1) is blocked by Software
Restriction Policy or Constrained Language Mode. It speaks the identical
clipboard protocol, so the Mac MCP server works with it unchanged.

WHAT IT DOES
    Watches the Windows clipboard for command "frames" the Mac MCP server puts
    there (Citrix keeps the clipboard synced), runs them, and writes results
    back to the clipboard.

SAFETY (read before running)
    - Only reacts to clipboard values starting with the marker "RDT1|". Normal
      copy/paste is ignored.
    - Does nothing on its own; only runs the commands you send from the Mac.
    - No network: it never opens a socket. The clipboard is the only channel.
    - No persistence: runs in this console only. Ctrl+C stops it. It installs no
      service, task, registry key, or startup entry.
    - Runs as you, no elevation. Every command is printed before it runs.
    - Guardrails: --dry-run echoes without executing; --deny-regex refuses
      commands matching a pattern.

DEPENDENCIES
    Standard library only. Needs Windows + any Python 3.6+. Commands run through
    Windows PowerShell (powershell.exe); the working directory persists between
    commands (variables/modules do not - each command is a fresh PowerShell).

USAGE
    python rdt_agent.py            # or:  py rdt_agent.py
    python rdt_agent.py --dry-run  # safe first test
"""

import argparse
import base64
import binascii
import ctypes
import gzip as gziplib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zlib
from ctypes import wintypes

FRAME_PREFIX = "RDT1|"
PROTO_V = 1

# ------------------------------------------------------------------ clipboard
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

# Win32 handles are loaded lazily so this module imports on any OS (the ctypes
# calls only run on Windows, when the clipboard/screenshot are actually used).
try:
    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _user32.OpenClipboard.argtypes = [wintypes.HWND]
    _user32.OpenClipboard.restype = wintypes.BOOL
    _user32.GetClipboardData.argtypes = [wintypes.UINT]
    _user32.GetClipboardData.restype = wintypes.HANDLE
    _user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    _user32.SetClipboardData.restype = wintypes.HANDLE
    _kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalLock.restype = wintypes.LPVOID
    _kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    _kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
except (AttributeError, OSError):  # not on Windows
    _user32 = None
    _kernel32 = None


def clip_get():
    """Read the clipboard as text, or '' if empty / non-text / busy."""
    if _user32 is None:
        return ""
    if not _user32.OpenClipboard(None):
        return ""
    try:
        handle = _user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""
        ptr = _kernel32.GlobalLock(handle)
        if not ptr:
            return ""
        try:
            return ctypes.c_wchar_p(ptr).value or ""
        finally:
            _kernel32.GlobalUnlock(handle)
    finally:
        _user32.CloseClipboard()


def clip_set(text):
    """Write text to the clipboard. Returns True on success."""
    if _user32 is None:
        return False
    data = text.encode("utf-16-le") + b"\x00\x00"
    if not _user32.OpenClipboard(None):
        return False
    try:
        _user32.EmptyClipboard()
        handle = _kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            return False
        ptr = _kernel32.GlobalLock(handle)
        ctypes.memmove(ptr, data, len(data))
        _kernel32.GlobalUnlock(handle)
        if not _user32.SetClipboardData(CF_UNICODETEXT, handle):
            _kernel32.GlobalFree(handle)
            return False
        return True  # system owns the handle now
    finally:
        _user32.CloseClipboard()


def clip_get_retry(retries=5, delay=0.03):
    for _ in range(retries):
        try:
            return clip_get()
        except Exception:
            time.sleep(delay)
    return ""


def clip_set_retry(text, retries=10, delay=0.05):
    for _ in range(retries):
        try:
            if clip_set(text):
                return True
        except Exception:
            pass
        time.sleep(delay)
    return False


# --------------------------------------------------------------------- frames
def encode_frame(obj):
    js = json.dumps(obj, separators=(",", ":"))
    return FRAME_PREFIX + base64.b64encode(js.encode("utf-8")).decode("ascii")


def decode_frame(raw):
    if not raw:
        return None
    t = raw.strip()
    if not t.startswith(FRAME_PREFIX):
        return None
    try:
        js = base64.b64decode(t[len(FRAME_PREFIX):]).decode("utf-8")
        obj = json.loads(js)
        if obj.get("v") != PROTO_V:
            return None
        if obj.get("role") not in ("m", "w"):
            return None
        if not isinstance(obj.get("n"), int):
            return None
        return obj
    except Exception:
        return None


def make_reply(sid, n, op, data=None, seq=None, total=None, fin=False):
    obj = {"v": PROTO_V, "sid": sid, "n": n, "role": "w", "op": op}
    if seq is not None:
        obj["seq"] = seq
    if total is not None:
        obj["total"] = total
    if fin:
        obj["fin"] = True
    if data is not None:
        obj["data"] = data
    return encode_frame(obj)


# ---------------------------------------------------------------- powershell
def ps_quote(value):
    return "'" + value.replace("'", "''") + "'"


_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW
_META = "RDT_META::"


class Shell:
    """Runs each command in a fresh PowerShell, but preserves the working
    directory between calls by threading it through a trailing marker line."""

    def __init__(self):
        self.cwd = None

    def run(self, cmd, timeout_ms):
        started = time.time()
        prefix = ("Set-Location -LiteralPath %s; " % ps_quote(self.cwd)) if self.cwd else ""
        wrapped = (
            prefix
            + "& {\n" + cmd + "\n} 2>&1 | Out-String -Width 4096; "
            + "Write-Output ('" + _META + "' + [string]$LASTEXITCODE + '::' + (Get-Location).Path)"
        )
        truncated = False
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", wrapped],
                capture_output=True, text=True,
                timeout=max(1.0, timeout_ms / 1000.0),
                creationflags=_NO_WINDOW,
            )
            out = proc.stdout or ""
            if proc.stderr:
                out += proc.stderr
        except subprocess.TimeoutExpired as exc:
            out = (exc.stdout or "")
            if isinstance(out, bytes):
                out = out.decode("utf-8", "replace")
            out += "\n[rdt] command exceeded %dms and was stopped.\n" % timeout_ms
            truncated = True

        exit_code = None
        idx = out.rfind(_META)
        if idx != -1:
            line = out[idx + len(_META):].splitlines()[0] if out[idx + len(_META):] else ""
            out = out[:idx].rstrip("\r\n")
            exit_str, _, new_cwd = line.partition("::")
            if new_cwd:
                self.cwd = new_cwd.strip()
            exit_str = exit_str.strip()
            if exit_str and exit_str.lower() != "null":
                try:
                    exit_code = int(exit_str)
                except ValueError:
                    exit_code = None
        return {
            "text": out,
            "exit": exit_code,
            "durationMs": int((time.time() - started) * 1000),
            "truncated": truncated,
        }


# ----------------------------------------------------------------- screenshot
def capture_png():
    """Capture the virtual desktop via GDI and encode PNG using only stdlib."""
    gdi32 = ctypes.windll.gdi32
    user32 = _user32
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    SM = user32.GetSystemMetrics
    x, y, w, h = SM(76), SM(77), SM(78), SM(79)  # virtual screen origin + size
    if w <= 0 or h <= 0:
        raise RuntimeError("could not determine screen size")

    SRCCOPY = 0x00CC0020
    hdc = user32.GetDC(None)
    memdc = gdi32.CreateCompatibleDC(hdc)
    hbmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(memdc, hbmp)
    gdi32.BitBlt(memdc, 0, 0, w, h, hdc, x, y, SRCCOPY)

    class BMIH(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    bmi = BMIH()
    bmi.biSize = ctypes.sizeof(BMIH)
    bmi.biWidth = w
    bmi.biHeight = -h  # top-down
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0  # BI_RGB
    buf = (ctypes.c_char * (w * h * 4))()
    gdi32.GetDIBits(memdc, hbmp, 0, h, buf, ctypes.byref(bmi), 0)

    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(memdc)
    user32.ReleaseDC(None, hdc)

    ba = bytearray(buf)          # BGRA, top-down
    ba[0::4], ba[2::4] = ba[2::4], ba[0::4]  # BGRA -> RGBA (swap B and R)
    ba[3::4] = b"\xff" * (w * h)             # force opaque alpha

    stride = w * 4
    raw = bytearray()
    for r in range(h):
        raw.append(0)  # PNG filter type 0 per scanline
        raw += ba[r * stride:(r + 1) * stride]
    compressed = zlib.compress(bytes(raw), 6)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


# ------------------------------------------------------------------ responder
class Agent:
    def __init__(self, args):
        self.args = args
        self.sid = None
        self.last_seen = 0
        self.last_reply = None
        self.last_resend = 0.0
        self.out = None            # active outbound stream (exec/get/shot)
        self.put_file = None       # active inbound file object (put)
        self.put_written = 0
        self.put_gzip = False
        self.put_final = None
        self.put_temp = None
        self.shell = Shell()

    def log(self, msg):
        if not self.args.quiet:
            print("[rdt %s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)

    def reset_transfer(self):
        if self.put_file:
            try:
                self.put_file.close()
            except Exception:
                pass
            self.put_file = None
        if self.put_temp:
            try:
                os.remove(self.put_temp)
            except OSError:
                pass
            self.put_temp = None
        self._close_out()

    def _close_out(self):
        if self.out:
            try:
                self.out["stream"].close()
            except Exception:
                pass
            temp = self.out.get("temp")
            if temp:
                try:
                    os.remove(temp)
                except OSError:
                    pass
        self.out = None

    def start_out(self, stream, length, meta, op, temp=None):
        """Begin streaming an outbound reply from a readable byte stream, reading
        the next chunk on demand so multi-GB files never sit in memory."""
        total = max(1, (length + self.args.chunk_bytes - 1) // self.args.chunk_bytes)
        self.out = {"stream": stream, "length": length, "total": total,
                    "meta": meta, "op": op, "temp": temp, "seq_next": 1}

    def emit(self, incoming_n, seq):
        stream = self.out["stream"]
        chunk = stream.read(self.args.chunk_bytes)
        fin = stream.tell() >= self.out["length"]
        data = {"chunk": base64.b64encode(chunk).decode("ascii")}
        if fin and self.out["meta"]:
            data["meta"] = self.out["meta"]
        op, total = self.out["op"], self.out["total"]
        reply = make_reply(self.sid, incoming_n + 1, op, data=data, seq=seq, total=total, fin=fin)
        if fin:
            self._close_out()
        return reply

    def err(self, n, message):
        return make_reply(self.sid, n + 1, "err", data={"message": message}, fin=True)

    def process(self, f):
        op = f.get("op")
        n = f["n"]
        data = f.get("data") or {}
        if op == "ping":
            info = {
                "version": PROTO_V,
                "host": _envs("COMPUTERNAME"),
                "user": _envs("USERNAME"),
                "pid": _os_pid(),
                "powershell": "python-agent",
                "gzip": True,
            }
            return make_reply(self.sid, n + 1, "ping", data=info, fin=True)

        if op == "exec":
            cmd = str(data.get("cmd", ""))
            timeout_ms = int(data.get("timeoutMs") or self.args.default_timeout_ms)
            self.log("exec: " + cmd)
            if self.args.deny_regex and re.search(self.args.deny_regex, cmd):
                return self.err(n, "command blocked by --deny-regex")
            if self.args.dry_run:
                result = {"text": "[dry-run] would run:\n%s\n" % cmd, "exit": None,
                          "durationMs": 0, "truncated": False}
            else:
                result = self.shell.run(cmd, timeout_ms)
            meta = {"exitCode": result["exit"], "durationMs": result["durationMs"],
                    "truncated": result["truncated"]}
            payload = result["text"].encode("utf-8")
            self.start_out(io.BytesIO(payload), len(payload), meta, "exec")
            return self.emit(n, 0)

        if op == "get":
            path = str(data.get("path", ""))
            want_gzip = bool(data.get("gzip"))
            self.log("get: " + path + (" (gzip)" if want_gzip else ""))
            try:
                if want_gzip:
                    temp = path + ".rdtdown"
                    with open(path, "rb") as src, gziplib.open(temp, "wb") as gz:
                        shutil.copyfileobj(src, gz, 1024 * 1024)
                    stream = open(temp, "rb")
                    self.start_out(stream, os.path.getsize(temp), None, "get", temp=temp)
                else:
                    stream = open(path, "rb")
                    self.start_out(stream, os.path.getsize(path), None, "get")
            except Exception as exc:
                return self.err(n, "read failed: %s" % exc)
            return self.emit(n, 0)

        if op == "shot":
            self.log("screenshot")
            try:
                payload = capture_png()
            except Exception as exc:
                return self.err(n, "screenshot failed: %s" % exc)
            self.start_out(io.BytesIO(payload), len(payload), None, "shot")
            return self.emit(n, 0)

        if op == "put":
            if f.get("seq") == 0:
                path = str(data.get("path", ""))
                overwrite = bool(data.get("overwrite"))
                self.put_gzip = bool(data.get("gzip"))
                self.put_final = path
                self.log("put: " + path + (" (gzip)" if self.put_gzip else ""))
                if os.path.exists(path) and not overwrite:
                    return self.err(n, "file exists and overwrite is false")
                try:
                    target = (path + ".rdtpart") if self.put_gzip else path
                    self.put_temp = target if self.put_gzip else None
                    self.put_file = open(target, "wb")
                    self.put_written = 0
                except Exception as exc:
                    return self.err(n, "open failed: %s" % exc)
                return make_reply(self.sid, n + 1, "ack", data={"ready": True})
            if not self.put_file:
                return self.err(n, "no active upload")
            try:
                blob = base64.b64decode(data.get("chunk", ""))
                self.put_file.write(blob)
                self.put_written += len(blob)
            except Exception as exc:
                return self.err(n, "write failed: %s" % exc)
            if f.get("fin"):
                self.put_file.close()
                self.put_file = None
                try:
                    if self.put_gzip:
                        with gziplib.open(self.put_temp, "rb") as gz, open(self.put_final, "wb") as out:
                            shutil.copyfileobj(gz, out, 1024 * 1024)
                        os.remove(self.put_temp)
                        written = os.path.getsize(self.put_final)
                    else:
                        written = self.put_written
                except Exception as exc:
                    return self.err(n, "finalize failed: %s" % exc)
                return make_reply(self.sid, n + 1, "ack",
                                  data={"ok": True, "bytesWritten": written}, fin=True)
            return make_reply(self.sid, n + 1, "ack", data={"seq": f.get("seq")})

        if op == "ack":
            if not self.out:
                return self.err(n, "unexpected ack")
            seq = self.out["seq_next"]
            self.out["seq_next"] = seq + 1
            return self.emit(n, seq)

        return self.err(n, "unknown op: %s" % op)

    def handle(self, f):
        """Process one inbound 'm' frame. Returns the encoded reply for a fresh
        frame, or None for a duplicate (the caller resends the last reply)."""
        if f.get("sid") != self.sid:
            self.sid = f.get("sid")
            self.last_seen = 0
            self.reset_transfer()
            self.log("session " + str(self.sid))
        n = f["n"]
        if n > self.last_seen:
            self.last_seen = n
            try:
                reply = self.process(f)
            except Exception as exc:
                reply = self.err(n, str(exc))
            self.last_reply = reply
            return reply
        return None

    def loop(self):
        poll = self.args.poll_ms / 1000.0
        resend = self.args.resend_ms / 1000.0
        while True:
            time.sleep(poll)
            raw = clip_get_retry()
            f = decode_frame(raw)
            if not f or f.get("role") != "m":
                continue
            reply = self.handle(f)
            if reply is not None:
                clip_set_retry(reply)
                self.last_resend = time.time()
            elif self.last_reply and (time.time() - self.last_resend) > resend:
                clip_set_retry(self.last_reply)
                self.last_resend = time.time()


def _envs(name):
    import os
    return os.environ.get(name, "")


def _os_pid():
    import os
    return os.getpid()


def main():
    p = argparse.ArgumentParser(description="Remote Desktop Terminal helper (Python responder).")
    p.add_argument("--poll-ms", type=int, default=250)
    p.add_argument("--chunk-bytes", type=int, default=262144)
    p.add_argument("--default-timeout-ms", type=int, default=120000)
    p.add_argument("--resend-ms", type=int, default=1500)
    p.add_argument("--dry-run", action="store_true", help="print commands but do not run them")
    p.add_argument("--deny-regex", default="", help="refuse commands matching this regex")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()

    if sys.platform != "win32":
        print("This helper must run on Windows.", file=sys.stderr)
        sys.exit(1)

    agent = Agent(args)
    print("")
    print("  Remote Desktop Terminal helper (Python)")
    print("  host=%s user=%s pid=%s" % (_envs("COMPUTERNAME"), _envs("USERNAME"), _os_pid()))
    print("  Watching clipboard. Every command is printed before it runs.")
    if args.dry_run:
        print("  DRY RUN: commands are shown but NOT executed.")
    if args.deny_regex:
        print("  Deny filter active: %s" % args.deny_regex)
    print("  Press Ctrl+C to stop.")
    print("")

    try:
        agent.loop()
    except KeyboardInterrupt:
        pass
    finally:
        agent.reset_transfer()
        print("\n[rdt] stopped.")


if __name__ == "__main__":
    main()
