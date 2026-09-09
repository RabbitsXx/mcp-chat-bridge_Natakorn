#!/usr/bin/env bash
# stop.sh — stop the Cloudflare tunnel and the local MCP gateway.
# Always run this when you finish a session: the tunnel has no auth beyond URL secrecy.
set -u

STATE_DIR="${STATE_DIR:-$HOME/.mcp-chat-bridge}"

echo "Stopping cloudflared tunnel..."
if pkill -f "cloudflared tunnel" >/dev/null 2>&1; then
  echo "  - cloudflared stopped"
else
  echo "  - no cloudflared running"
fi

GATEWAY_PORT="${GATEWAY_PORT:-8791}"
for PORT in "$GATEWAY_PORT" 8792; do
  if command -v pkill >/dev/null 2>&1; then
    if pkill -f "supergateway.*--port $PORT" >/dev/null 2>&1; then
      echo "  - gateway on port $PORT stopped"
    fi
  fi
  # Windows/Git Bash fallback: pkill -f often can't match MSYS processes, so
  # kill whatever is actually LISTENING on the gateway ports.
  if command -v netstat >/dev/null 2>&1 && command -v taskkill >/dev/null 2>&1; then
    for PID in $(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $NF}' | sort -u); do
      taskkill //F //PID "$PID" >/dev/null 2>&1 && echo "  - gateway on port $PORT stopped"
    done
  fi
done

# Windows (Git Bash) fallback: kill by image name
if command -v taskkill >/dev/null 2>&1; then
  taskkill //F //IM cloudflared.exe >/dev/null 2>&1 || true
fi

echo "✅ Stopped — MCP clients can no longer reach your machine until you run start.sh again."
