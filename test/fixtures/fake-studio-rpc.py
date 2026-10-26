"""Stands in for studio_remote_rpc.py in tests: same argv, canned replies, and a log of the exact
params each call received — so a test can prove the user's words arrived intact, not interpreted."""
import json, os, sys
args = sys.argv[1:]
cid = args[args.index("--computer-id") + 1]
method, params = args[-2], json.loads(args[-1])
log = os.environ["FAKE_STUDIO_LOG"]
with open(log, "a") as f:
    f.write(json.dumps({"cid": cid, "method": method, "params": params}) + "\n")
state_file = log + ".state"
mode = os.environ.get("FAKE_STUDIO_MODE", "complete")
if mode == "refuse" and params.get("operation") == "send":
    print(json.dumps({"jsonrpc": "2.0", "id": "studio-rpc", "error": {"code": 4091, "message": "Request id was already used for different content"}}))
    sys.exit(1)
if mode == "permission":
    print("Traceback (most recent call last):\nPermissionError: [Errno 13] Permission denied: '/root/.hermes/studio/gateway-token'", file=sys.stderr)
    sys.exit(1)
if params.get("operation") == "send":
    open(state_file, "w").write(json.dumps({"id": params["request_id"], "body": params["message"]}))
    print(json.dumps({"jsonrpc": "2.0", "id": "studio-rpc", "result": {"id": params["request_id"], "state": "queued"}}))
    sys.exit(0)
d = json.loads(open(state_file).read()) if os.path.exists(state_file) else {"id": "none"}
state = "complete" if mode == "complete" else "running"
others = [{"id": "x" * 32, "state": "complete", "result": "someone else's secret work"}]
print(json.dumps({"jsonrpc": "2.0", "id": "studio-rpc", "result": {"deliveries": others + [{"id": d["id"], "state": state, "result": "I'm on Orgo 00000000, us-east." if state == "complete" else None}]}}))
