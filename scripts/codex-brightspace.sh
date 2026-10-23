#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repository"

if [ ! -f dist/cli.js ]; then
  printf '%s\n' 'Build the Brightspace server first: npm run build' >&2
  exit 1
fi

# Encode TOML string/array values, then pass them as individual arguments without eval.
node_command=$(node -p 'JSON.stringify(process.execPath)')
server_args=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1], "serve"]))' "$repository/dist/cli.js")
server_cwd=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$repository")

# These overrides apply only to this Codex invocation. No persistent config is written.
exec codex \
  --config "mcp_servers.d2l.command=$node_command" \
  --config "mcp_servers.d2l.args=$server_args" \
  --config "mcp_servers.d2l.cwd=$server_cwd" \
  --config 'mcp_servers.d2l.enabled=true' \
  --config 'mcp_servers.d2l.required=true' \
  --config 'mcp_servers.d2l.startup_timeout_sec=30' \
  --config 'mcp_servers.d2l.tool_timeout_sec=600' \
  --config 'mcp_servers.d2l.env_vars=["D2L_MCP_CONFIG", "D2L_ACCESS_TOKEN"]' \
  "$@"
