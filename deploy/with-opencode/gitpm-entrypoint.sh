#!/bin/bash
export BROWSER=/bin/true
set -e

echo "[entrypoint] Generate Caddyfile..."
if [ -z "$BASIC_AUTH_USER" ] || [ -z "$BASIC_AUTH_PASS" ]; then
  echo "[entrypoint] WARNING: BASIC_AUTH_* not set, starting Caddy WITHOUT auth"
  cat > /tmp/Caddyfile <<'CADDYEOF'
:80 {
    reverse_proxy 127.0.0.1:5173
}
CADDYEOF
else
  HASH=$(caddy hash-password --plaintext "$BASIC_AUTH_PASS")
  cat > /tmp/Caddyfile <<CADDYEOF
:80 {
    basicauth {
        $BASIC_AUTH_USER $HASH
    }
    reverse_proxy 127.0.0.1:5173
}
CADDYEOF
fi

echo "[entrypoint] Start GitPM (server+web)..."
cd /app
node scripts/run-gitpm-local.mjs &
GITPM_PID=$!

echo "[entrypoint] Start opencode web on :4096..."
opencode web --hostname 0.0.0.0 --port 4096 &
OC_PID=$!

echo "[entrypoint] Start Caddy on :80 -> 5173..."
caddy run --config /tmp/Caddyfile --adapter caddyfile &
CADDY_PID=$!

trap 'echo "[entrypoint] shutdown"; kill -TERM $GITPM_PID $OC_PID $CADDY_PID 2>/dev/null; wait' TERM INT

while kill -0 $GITPM_PID 2>/dev/null && kill -0 $OC_PID 2>/dev/null && kill -0 $CADDY_PID 2>/dev/null; do
  sleep 2
done

echo "[entrypoint] a child exited, shutting down"
kill -TERM $GITPM_PID $OC_PID $CADDY_PID 2>/dev/null || true
wait
exit 1
