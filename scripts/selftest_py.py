#!/usr/bin/env python3
"""
Responder self-test for windows/rdt_agent.py. Drives the Python responder with a
tiny Mac-side simulator (mirroring src/relay.ts) over synthetic frames, using a
small chunk size so multi-frame streaming runs. No Windows needed: the shell is
mocked and screenshot is skipped (both are Windows-only).

Run:  python3 scripts/selftest_py.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "windows"))
import rdt_agent as A  # noqa: E402


class Args:
    poll_ms = 4
    chunk_bytes = 64  # tiny on purpose: forces multi-chunk transfers
    default_timeout_ms = 5000
    resend_ms = 1500
    dry_run = False
    deny_regex = ""
    quiet = True


class FakeShell:
    def run(self, cmd, timeout_ms):
        return {"text": ("echo:%s\n" % cmd) * 40, "exit": 0, "durationMs": 1, "truncated": False}


class MacSim:
    """Minimal stand-in for src/relay.ts: monotonic n, stop-and-wait, drains
    multi-frame replies by ACKing until fin."""

    def __init__(self, agent):
        self.agent = agent
        self.sid = "TST"
        self.last_n = 0

    def _send(self, op, **extra):
        n = self.last_n + 1
        frame = {"v": 1, "sid": self.sid, "n": n, "role": "m", "op": op}
        frame.update(extra)
        self.last_n = n
        encoded = self.agent.handle(frame)
        reply = A.decode_frame(encoded)
        assert reply is not None, "agent returned no reply"
        self.last_n = reply["n"]
        return reply

    def _drain(self, first):
        chunks = []
        reply = first
        while True:
            d = reply.get("data") or {}
            if d.get("chunk"):
                chunks.append(__import__("base64").b64decode(d["chunk"]))
            if reply.get("fin"):
                return b"".join(chunks), reply
            reply = self._send("ack", data={"seq": reply.get("seq")})

    def ping(self):
        return self._send("ping", data={"t": 1}).get("data")

    def exec(self, cmd):
        first = self._send("exec", data={"cmd": cmd, "timeoutMs": 5000})
        buf, last = self._drain(first)
        meta = (last.get("data") or {}).get("meta") or {}
        return buf.decode("utf-8"), meta

    def put(self, path, data, overwrite=True):
        import base64
        total = max(1, (len(data) + Args.chunk_bytes - 1) // Args.chunk_bytes)
        self._send("put", seq=0, total=total, data={"path": path, "totalBytes": len(data), "overwrite": overwrite})
        ack = None
        for i in range(total):
            chunk = data[i * Args.chunk_bytes:(i + 1) * Args.chunk_bytes]
            ack = self._send("put", seq=i + 1, total=total, fin=(i + 1 == total),
                             data={"chunk": base64.b64encode(chunk).decode()})
        return (ack.get("data") or {}).get("bytesWritten")

    def get(self, path):
        first = self._send("get", data={"path": path})
        buf, _ = self._drain(first)
        return buf


failures = 0


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, (" - " + detail) if detail else ""))


def main():
    agent = A.Agent(Args())
    agent.shell = FakeShell()
    mac = MacSim(agent)

    print("Running Python responder self-test (tiny 64B chunks)...")

    info = mac.ping()
    check("ping round-trips", info and info.get("version") == 1, "pid=%s" % (info or {}).get("pid"))

    out, meta = mac.exec("Get-Date")
    check("exec streams multi-chunk output", "echo:Get-Date" in out and meta.get("exitCode") == 0,
          "len=%d exit=%s" % (len(out), meta.get("exitCode")))

    payload = bytes((i * 31 + 7) & 0xFF for i in range(5000))
    tmp = os.path.join(tempfile.gettempdir(), "rdt_selftest.bin")
    written = mac.put(tmp, payload, True)
    check("upload reports byte count", written == len(payload), "bytes=%s" % written)

    got = mac.get(tmp)
    check("download round-trips identical bytes", got == payload, "len=%d" % len(got))
    try:
        os.remove(tmp)
    except OSError:
        pass

    # Codec vector for cross-language check with the TS relay.
    vector = A.encode_frame({"v": 1, "sid": "S", "n": 5, "role": "w", "op": "ping", "fin": True, "data": {"version": 1}})
    print("CODEC_VECTOR " + vector)

    print("\nALL PASS" if failures == 0 else "\n%d FAILED" % failures)
    sys.exit(0 if failures == 0 else 1)


if __name__ == "__main__":
    main()
