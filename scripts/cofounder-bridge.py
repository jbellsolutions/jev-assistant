#!/usr/bin/env python3
"""The co-founder's bridge to Jev: an MCP server over stdio that forwards every message to Jev's
MCP endpoint on the user's Mac (Streamable HTTP, tailnet only — server/mcp-remote.ts).

Why a bridge at all: the co-founder's box runs tailscaled with --tun=userspace-networking and no
proxy, so an ordinary socket can't reach a tailnet address (measured 2026-09-26: curl → 000, while
`tailscale nc` → Jev's 401). Hermes launches this as a stdio MCP server; each message rides one
`tailscale nc` connection. Nothing here is a service, nothing listens.

Stdlib only. The token is read from a root-only file, never from the command line.
"""
import json
import os
import shlex
import subprocess
import sys
import threading

HOST = os.environ.get("JEV_HOST", "100.109.42.61")
PORT = int(os.environ.get("JEV_PORT", "3112"))
TOKEN_FILE = os.environ.get("JEV_TOKEN_FILE", "/root/.hermes/jev-cofounder-token")
NC = shlex.split(os.environ.get("JEV_NC", f"tailscale --socket=/var/run/tailscale/tailscaled.sock nc {HOST} {PORT}"))
TIMEOUT = float(os.environ.get("JEV_TIMEOUT", "150"))  # jev_do waits up to 60s; room for approvals


def token() -> str:
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def read_response(stream) -> tuple[int, bytes]:
    status_line = stream.readline()
    if not status_line:
        raise ConnectionError("Jev closed the connection without answering")
    status = int(status_line.split()[1])
    headers = {}
    while True:
        line = stream.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        k, _, v = line.decode("latin-1").partition(":")
        headers[k.strip().lower()] = v.strip()
    if "content-length" in headers:
        return status, stream.read(int(headers["content-length"]))
    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = b""
        while True:
            size = int(stream.readline().strip().split(b";")[0], 16)
            if size == 0:
                stream.readline()
                return status, body
            body += stream.read(size)
            stream.readline()
    return status, stream.read()


def post(body: bytes) -> tuple[int, bytes]:
    head = (
        f"POST /mcp HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nAuthorization: Bearer {token()}\r\n"
        "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode()
    p = subprocess.Popen(NC, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    killer = threading.Timer(TIMEOUT, p.kill)
    killer.start()
    try:
        # stdin stays open until the answer is read: nc hangs up as soon as its input closes
        p.stdin.write(head + body)
        p.stdin.flush()
        return read_response(p.stdout)
    finally:
        killer.cancel()
        try:
            p.stdin.close()
        except OSError:
            pass
        p.kill()
        p.wait()


def error_reply(msg_id, text: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32000, "message": text}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg_id = msg.get("id") if isinstance(msg, dict) else None
        try:
            status, body = post(line.encode())
        except Exception as err:  # noqa: BLE001 — every failure goes back as an answer
            if msg_id is not None:
                print(json.dumps(error_reply(msg_id, f"Can't reach Jev on the user's Mac: {err}")), flush=True)
            continue
        if msg_id is None:
            continue  # a notification: Jev answers 202 with nothing to pass on
        if status >= 400 or not body.strip():
            reason = {401: "Jev refused the token", 403: "not on the tailnet", 404: "no MCP endpoint"}.get(status, f"HTTP {status}")
            print(json.dumps(error_reply(msg_id, f"Jev: {reason}")), flush=True)
            continue
        text = body.decode("utf-8", "replace").strip()
        if text.startswith("event:") or text.startswith("data:"):  # an SSE answer: take its data lines
            text = "\n".join(l[5:].strip() for l in text.splitlines() if l.startswith("data:"))
        print(text, flush=True)


if __name__ == "__main__":
    main()
