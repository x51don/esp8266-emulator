#!/usr/bin/env bash
# Stop the emulator. Usage: ./stop.sh [dev|prod|all] (default: all)
set -uo pipefail
cd "$(dirname "$0")"

stop_one() {
  local mode="$1"
  local pidfile=".run/$mode.pid"
  [[ -f "$pidfile" ]] || { echo "$mode: not running"; return; }
  local pid
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    # the pid is a session leader (setsid); kill the whole group, then confirm
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    for _ in $(seq 1 25); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
    echo "$mode: stopped (pid $pid)"
  else
    echo "$mode: stale pidfile removed"
  fi
  rm -f "$pidfile"
}

case "${1:-all}" in
  dev)  stop_one dev ;;
  prod) stop_one prod ;;
  all)  stop_one dev; stop_one prod ;;
  *)    echo "usage: $0 [dev|prod|all]" >&2; exit 2 ;;
esac
