#!/usr/bin/env python3
"""Helper to run multiple read-only SQL queries via Supabase MCP and extract JSON results."""
import json
import re
import subprocess
import sys

ACCESS_TOKEN = "REPLACE_WITH_ENV_VAR"
PROJECT_REF = "manvezhphopngpnaiyjv"


def run_queries(queries: list[tuple[str, str]]) -> dict[str, list[dict]]:
    """Run multiple SQL queries via single MCP session. Returns {label: rows}."""
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "metrics", "version": "0.1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    ]
    for i, (label, sql) in enumerate(queries, start=2):
        msgs.append({"jsonrpc": "2.0", "id": i, "method": "tools/call",
                     "params": {"name": "execute_sql", "arguments": {"query": sql}}})

    stdin = "\n".join(json.dumps(m) for m in msgs) + "\n"

    proc = subprocess.run(
        ["npx", "-y", "@supabase/mcp-server-supabase@latest",
         "--access-token", ACCESS_TOKEN, "--project-ref", PROJECT_REF],
        input=stdin, capture_output=True, text=True, timeout=300, shell=True,
    )

    out = proc.stdout
    results: dict[str, list] = {}
    label_by_id = {i: label for i, (label, _) in enumerate(queries, start=2)}

    for line in out.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "result" not in obj or "id" not in obj:
            continue
        rid = obj["id"]
        if rid not in label_by_id:
            continue
        label = label_by_id[rid]
        try:
            content = obj["result"]["content"][0]["text"]
            inner = json.loads(content)
            text = inner.get("result", inner) if isinstance(inner, dict) else inner
            if isinstance(text, str):
                m = re.search(r"<untrusted-data-[^>]+>\s*(.*?)\s*</untrusted-data-",
                              text, re.DOTALL)
                if m:
                    results[label] = json.loads(m.group(1))
                else:
                    results[label] = {"_raw": text}
            else:
                results[label] = text
        except Exception as e:
            results[label] = {"_error": str(e), "_obj": obj}

    return results


if __name__ == "__main__":
    queries_file = sys.argv[1] if len(sys.argv) > 1 else None
    if queries_file:
        with open(queries_file) as f:
            queries = json.load(f)
    else:
        queries = [
            ("test", "SELECT NOW()::text AS now"),
        ]
    results = run_queries(queries)
    print(json.dumps(results, indent=2, default=str, ensure_ascii=False))
