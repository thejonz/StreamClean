#!/usr/bin/env bash
# StreamClean dev server helper
#
# Usage:
#   ./streamclean.sh           # stop anything on :8765, then start (default)
#   ./streamclean.sh restart   # same as above
#   ./streamclean.sh stop      # stop only
#   ./streamclean.sh start     # start only (fails if port in use)
#   ./streamclean.sh status    # show whether the server is running

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8765
HOST=127.0.0.1
URL="http://${HOST}:${PORT}"
VENV="$ROOT/.venv"
PYTHON="$VENV/bin/python"

pids_on_port() {
  lsof -ti ":$PORT" 2>/dev/null || true
}

stop_server() {
  local pids
  pids="$(pids_on_port)"
  if [[ -z "$pids" ]]; then
    echo "StreamClean is not running on port $PORT."
    return 0
  fi

  echo "Stopping StreamClean (port $PORT)…"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.4

  pids="$(pids_on_port)"
  if [[ -n "$pids" ]]; then
    echo "Force stopping…"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 0.2
  fi

  if [[ -n "$(pids_on_port)" ]]; then
    echo "Could not free port $PORT." >&2
    return 1
  fi

  echo "Stopped."
}

ensure_venv() {
  if [[ ! -x "$PYTHON" ]]; then
    echo "Creating virtualenv in .venv…"
    python3 -m venv "$VENV"
  fi

  if ! "$PYTHON" -c "import fastapi" 2>/dev/null; then
    echo "Installing dependencies…"
    "$VENV/bin/pip" install -r "$ROOT/requirements.txt"
  fi
}

start_server() {
  if [[ -n "$(pids_on_port)" ]]; then
    echo "Port $PORT is already in use. Run: $0 stop" >&2
    exit 1
  fi

  ensure_venv

  if [[ ! -f "$ROOT/.env" ]]; then
    echo "Note: .env not found — copy .env.example to .env and add API keys."
  fi

  echo "Starting StreamClean at $URL"
  cd "$ROOT"
  exec "$PYTHON" run.py
}

show_status() {
  local pids
  pids="$(pids_on_port)"
  if [[ -n "$pids" ]]; then
    echo "StreamClean is running on $URL"
    echo "PIDs: $pids"
  else
    echo "StreamClean is not running on port $PORT."
  fi
}

restart_server() {
  stop_server || true
  start_server
}

cmd="${1:-restart}"
case "$cmd" in
  stop)
    stop_server
    ;;
  start)
    start_server
    ;;
  restart|reset)
    restart_server
    ;;
  status)
    show_status
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Usage: $0 [stop|start|restart|reset|status]" >&2
    exit 1
    ;;
esac
