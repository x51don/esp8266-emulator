#!/usr/bin/env bash
# Start the emulator. Usage: ./start.sh [dev|prod] (default: dev)
#   dev  - vite dev server with HMR on http://127.0.0.1:5188
#   prod - build, then serve dist/ on http://127.0.0.1:8090
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-dev}"

# No dependency on pnpm/npm being on PATH - run the local toolchain directly.
if [[ ! -x node_modules/.bin/vite ]]; then
  echo "node_modules missing - run: pnpm install (or npm install)" >&2
  exit 1
fi
mkdir -p .run
PORT=5188
LOG=".run/$MODE.log"
PIDFILE=".run/$MODE.pid"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running ($MODE, pid $(cat "$PIDFILE"))"
  exit 0
fi

# setsid gives the server its own session so stop.sh can kill the whole
# group; the leader records its own pid (the $! of `setsid` would be the
# short-lived forker when it is already a process-group leader).
if [[ "$MODE" == prod ]]; then
  PORT=8090
  echo "building..."
  node_modules/.bin/tsc -p tsconfig.json --noEmit && node_modules/.bin/vite build >/dev/null || { echo "build failed" >&2; exit 1; }
  setsid bash -c "echo \$\$ > '$PIDFILE'; exec python3 -m http.server $PORT --bind 127.0.0.1 --directory dist" >"$LOG" 2>&1 &
else
  setsid bash -c "echo \$\$ > '$PIDFILE'; exec '$PWD/node_modules/.bin/vite'" >"$LOG" 2>&1 &
fi
sleep 0.3
PID="$(cat "$PIDFILE" 2>/dev/null || true)"

for _ in $(seq 1 100); do
  if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/"; then
    echo "started ($MODE, pid $PID) -> http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.2
done

echo "did not come up within 20s; log tail:" >&2
tail -20 "$LOG" >&2
rm -f "$PIDFILE"
exit 1
