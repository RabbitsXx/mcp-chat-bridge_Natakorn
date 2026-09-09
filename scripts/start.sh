#!/usr/bin/env bash
# start.sh — start the MCP gateway (stdio -> Streamable HTTP) + Cloudflare tunnel
# so ChatGPT Chat (or any Streamable HTTP MCP client) can reach a local MCP server.
#
# Configure via environment variables or .env (see .env.example):
#   ROOTS            — space-separated list of directories the MCP server may access
#   MCP_COMMAND      — command to launch the MCP stdio server (default: filesystem server via npx)
#   GATEWAY_PORT     — local gateway port (default 8791)
#   NODE_BIN         — node executable (default: node from PATH)
#   CLOUDFLARED_BIN  — cloudflared binary (default: cloudflared from PATH)
#
# Usage:  bash scripts/start.sh
# Stop:   bash scripts/stop.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# --- optional .env at repo root (KEY=VALUE lines) ---
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env"
  set +a
fi

ROOTS="${ROOTS:-$PWD}"
MCP_COMMAND="${MCP_COMMAND:-npx -y @modelcontextprotocol/server-filesystem}"
GATEWAY_PORT="${GATEWAY_PORT:-8791}"
NODE_BIN="${NODE_BIN:-node}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
STATE_DIR="${STATE_DIR:-$HOME/.mcp-chat-bridge}"

mkdir -p "$STATE_DIR"
GATEWAY_LOG="$STATE_DIR/gateway.log"
TUNNEL_LOG="$STATE_DIR/tunnel.log"

echo "[1/3] Stopping old processes (if any)..."
bash "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
sleep 1

echo "[2/3] Starting MCP gateway (stdio -> Streamable HTTP at localhost:$GATEWAY_PORT)..."
MSYS_NO_PATHCONV=1 nohup npx --yes supergateway@latest \
  --stdio "$MCP_COMMAND $ROOTS" \
  --outputTransport streamableHttp \
  --port "$GATEWAY_PORT" \
  --streamableHttpPath /mcp \
  --logLevel info > "$GATEWAY_LOG" 2>&1 < /dev/null &
disown
sleep 4

if ! curl -sf "http://127.0.0.1:$GATEWAY_PORT/healthz" >/dev/null 2>&1; then
  # supergateway has no /healthz on all versions; treat "port listening" as OK
  if ! (echo > "/dev/tcp/127.0.0.1/$GATEWAY_PORT") >/dev/null 2>&1; then
    echo "❌ Gateway did not start — see log: $GATEWAY_LOG"
    exit 1
  fi
fi

echo "[3/3] Opening Cloudflare tunnel..."
nohup "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$GATEWAY_PORT" --no-autoupdate \
  > "$TUNNEL_LOG" 2>&1 < /dev/null &
disown

URL=""
for _ in $(seq 1 25); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "❌ No tunnel URL found — see log: $TUNNEL_LOG"
  echo "   (You can still use the local endpoint: http://localhost:$GATEWAY_PORT/mcp)"
  exit 1
fi

echo ""
echo "======================================================"
echo "✅ Ready! Paste this URL into your MCP client:"
echo ""
echo "   ${URL}/mcp"
echo ""
echo "   ChatGPT → Settings → Connectors → edit connector → Server URL"
echo "   Allowed directories: ${ROOTS}"
echo "   Stop: bash scripts/stop.sh"
echo "======================================================"
