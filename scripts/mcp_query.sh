#!/bin/bash
# Run a single read-only SQL query via Supabase MCP and print the JSON array result.
# Usage: ./mcp_query.sh "SELECT 1 AS x"
SQL="$1"
JSON_SQL=$(printf '%s' "$SQL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"q","version":"0.1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_sql","arguments":{"query":%s}}}\n' "$JSON_SQL"
  sleep 7
} | npx -y @supabase/mcp-server-supabase@latest \
  --access-token REPLACE_WITH_ENV_VAR \
  --project-ref manvezhphopngpnaiyjv 2>/dev/null | python3 -c '
import json, re, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"): continue
    try: obj = json.loads(line)
    except: continue
    if obj.get("id") != 2: continue
    txt = obj["result"]["content"][0]["text"]
    inner = json.loads(txt)
    if isinstance(inner, dict) and "error" in inner:
        print("ERROR:", inner["error"]); sys.exit(1)
    s = inner["result"] if isinstance(inner, dict) else inner
    parts = s.split("<untrusted-data-", 2)
    if len(parts) >= 3:
        body = parts[2].split(">", 1)[1].split("</untrusted-data-", 1)[0].strip()
        print(body)
    else:
        print(s)
    sys.exit(0)
sys.exit(2)
'
