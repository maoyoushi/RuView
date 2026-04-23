#!/usr/bin/env bash
# restart-sensing-server.sh — Force-stop and (re)start wifi-densepose-sensing-server
#
# Defaults match the local dev deployment: HTTP 3001, WS 8765, UDP 5005,
# source=esp32, bind 0.0.0.0, UI served from <repo>/ui (absolute path so it
# doesn't matter what cwd we run from). Logs go to /tmp/sensing-server.log.
#
# Default behavior is to PRINT HELP — pass --restart to actually restart.
# This avoids accidental restarts (which kill any open WebSocket connections
# from browser tabs) when the user just wants to remember the flags.

set -euo pipefail

# ── Help ─────────────────────────────────────────────────────────────────────
print_help() {
  cat <<'HELP'
restart-sensing-server.sh — Force-stop and (re)start the WiFi-DensePose
sensing-server with health verification.

By default this script ONLY prints help. Pass --restart to perform the
actual rebuild+restart cycle. This is intentional: a restart drops every
WebSocket client (e.g. open browser tabs on /ui/presence.html), so the
script refuses to do it by accident.

ACTIONS (mutually exclusive — pick one):
  (no flag)       Print this help and exit.
  --restart       Stop any running instance, rebuild, start, verify.
  --stop          Stop any running instance and exit.
  --status        Report whether the server is running, no changes.
  -h, --help      Print this help.

CONFIGURATION (apply to --restart and --status):
  --no-build              Skip the cargo build step before starting.
                          Use when you've just built or want a fast restart.
  --release               Use target/release/sensing-server (default debug).
  --http-port  N          HTTP port (default 3001).
  --ws-port    N          WebSocket port (default 8765).
  --udp-port   N          UDP port for ESP32 CSI/vitals (default 5005).
  --bind-addr  ADDR       Bind address (default 0.0.0.0 — LAN reachable).
                          Use 127.0.0.1 to restrict to localhost.
  --source     NAME       Data source: esp32 | simulated | wifi (default esp32).
  --log-file   PATH       Where to redirect stdout/stderr
                          (default /tmp/sensing-server.log).

EXAMPLES:
  bash scripts/restart-sensing-server.sh                       # show this help
  bash scripts/restart-sensing-server.sh --status              # check state
  bash scripts/restart-sensing-server.sh --restart             # rebuild + restart
  bash scripts/restart-sensing-server.sh --restart --no-build  # quick restart
  bash scripts/restart-sensing-server.sh --restart --release   # release build
  bash scripts/restart-sensing-server.sh --restart --source simulated
  bash scripts/restart-sensing-server.sh --restart --http-port 8080
  bash scripts/restart-sensing-server.sh --stop                # just stop

EXIT CODES:
  0  Success (--restart: server up and probes pass; --stop: stopped cleanly;
     --status: running; help: always 0).
  1  Failed to stop something holding the ports, OR --status: not running.
  2  Build failed or binary missing or unknown flag.
  3  Server started but /health or /ui/index.html did not return 200.

OUTPUTS:
  Log file:   /tmp/sensing-server.log (or --log-file)
  PID file:   /tmp/sensing-server.pid (most recent --restart only)
HELP
}

# ── Paths ────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="$REPO_ROOT/rust-port/wifi-densepose-rs"
UI_DIR="$REPO_ROOT/ui"
LOG_FILE="/tmp/sensing-server.log"
BUILD_PROFILE="debug"
BIN_PATH=""  # resolved after parsing flags

# ── Defaults (match the dev deployment) ──────────────────────────────────────
HTTP_PORT=3001
WS_PORT=8765
UDP_PORT=5005
BIND_ADDR="0.0.0.0"
SOURCE="esp32"

# ── Modes ────────────────────────────────────────────────────────────────────
DO_BUILD=1
# Default action is "help". Restart must be opt-in via --restart so we never
# kill an active web session by reflex.
ACTION="help"  # help | restart | stop | status

# ── Args ─────────────────────────────────────────────────────────────────────
while (( $# > 0 )); do
  case "$1" in
    --restart) ACTION="restart"; shift ;;
    --stop) ACTION="stop"; shift ;;
    --status) ACTION="status"; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --release) BUILD_PROFILE="release"; shift ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --ws-port) WS_PORT="$2"; shift 2 ;;
    --udp-port) UDP_PORT="$2"; shift 2 ;;
    --bind-addr) BIND_ADDR="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    -h|--help) ACTION="help"; shift ;;
    *) echo "unknown flag: $1" >&2; echo "Run with --help to see usage." >&2; exit 2 ;;
  esac
done

BIN_PATH="$RUST_DIR/target/$BUILD_PROFILE/sensing-server"

# ── Helpers ──────────────────────────────────────────────────────────────────

# Find every PID associated with the sensing-server: by binary name AND by
# anyone holding our ports. Prevents an orphaned process from blocking the
# port even if its binary path doesn't match the expected pattern.
collect_pids() {
  {
    pgrep -f "target/(debug|release)/sensing-server" 2>/dev/null || true
    lsof -t -iTCP:"$HTTP_PORT" -sTCP:LISTEN 2>/dev/null || true
    lsof -t -iTCP:"$WS_PORT"   -sTCP:LISTEN 2>/dev/null || true
    lsof -t -iUDP:"$UDP_PORT"                 2>/dev/null || true
  } | sort -u | grep -vE '^$'
}

stop_server() {
  local pids
  pids="$(collect_pids || true)"
  if [[ -z "$pids" ]]; then
    echo "  (nothing to stop)"
    return 0
  fi

  echo "  sending SIGINT to: $(echo $pids | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -INT $pids 2>/dev/null || true

  # Wait up to 5 s for graceful shutdown.
  for i in 1 2 3 4 5; do
    sleep 1
    pids="$(collect_pids || true)"
    if [[ -z "$pids" ]]; then
      echo "  graceful stop in ${i}s"
      return 0
    fi
  done

  echo "  still alive after 5s, sending SIGKILL: $(echo $pids | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
  sleep 1
  pids="$(collect_pids || true)"
  if [[ -n "$pids" ]]; then
    echo "  ERROR: pids still alive after SIGKILL: $pids" >&2
    return 1
  fi
  return 0
}

build_server() {
  if (( DO_BUILD == 0 )); then
    echo "  skipped (--no-build)"
    return 0
  fi
  if [[ ! -d "$RUST_DIR" ]]; then
    echo "  ERROR: rust workspace not found at $RUST_DIR" >&2
    return 2
  fi
  local build_args=(build --manifest-path "$RUST_DIR/Cargo.toml" -p wifi-densepose-sensing-server --no-default-features)
  if [[ "$BUILD_PROFILE" == "release" ]]; then
    build_args+=(--release)
  fi
  echo "  cargo ${build_args[*]}"
  if ! OPENBLAS_DIR=/opt/homebrew/opt/openblas cargo "${build_args[@]}" 2>&1 | tail -3; then
    echo "  ERROR: build failed" >&2
    return 2
  fi
  if [[ ! -x "$BIN_PATH" ]]; then
    echo "  ERROR: built binary missing at $BIN_PATH" >&2
    return 2
  fi
}

start_server() {
  if [[ ! -x "$BIN_PATH" ]]; then
    echo "  ERROR: $BIN_PATH does not exist or is not executable" >&2
    echo "  hint: run without --no-build to build it first" >&2
    return 2
  fi
  if [[ ! -d "$UI_DIR" ]]; then
    echo "  WARN: UI dir $UI_DIR not found — /ui/* will return 404"
  fi

  local args=(
    --http-port "$HTTP_PORT"
    --ws-port "$WS_PORT"
    --udp-port "$UDP_PORT"
    --bind-addr "$BIND_ADDR"
    --ui-path "$UI_DIR"
    --source "$SOURCE"
  )

  echo "  $BIN_PATH ${args[*]}"
  echo "  log: $LOG_FILE"

  # Start detached, owned by init (nohup + disown) so the script exit doesn't
  # take it down. Redirect both fds to the log.
  OPENBLAS_DIR=/opt/homebrew/opt/openblas \
  RUST_LOG="${RUST_LOG:-info}" \
    nohup "$BIN_PATH" "${args[@]}" > "$LOG_FILE" 2>&1 &
  local new_pid=$!
  disown $new_pid 2>/dev/null || true
  echo "$new_pid" > /tmp/sensing-server.pid
  echo "  started PID=$new_pid"
}

# Health probe: HTTP /health AND /ui/index.html (catches the path-resolution
# regression where the binary runs but UI 404s).
verify_running() {
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    local pid_now
    pid_now="$(collect_pids | head -1 || true)"
    if [[ -z "$pid_now" ]]; then continue; fi

    local code_health code_ui
    code_health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$HTTP_PORT/health" || echo 000)"
    code_ui="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$HTTP_PORT/ui/index.html" || echo 000)"

    if [[ "$code_health" == "200" && "$code_ui" == "200" ]]; then
      echo "  /health=200 /ui/index.html=200 (after ${i}s)"
      return 0
    fi
    if (( i == 8 )); then
      echo "  ERROR: probes after 8s — /health=$code_health /ui/index.html=$code_ui" >&2
      echo "  log tail:" >&2
      tail -20 "$LOG_FILE" >&2 || true
      return 3
    fi
  done
}

print_status() {
  local pids
  pids="$(collect_pids || true)"
  if [[ -z "$pids" ]]; then
    echo "status: STOPPED"
    return 1
  fi
  echo "status: RUNNING"
  echo "pids:   $(echo $pids | tr '\n' ' ')"
  for p in $pids; do
    ps -p "$p" -o pid,user,etime,command 2>/dev/null | tail -n +2 || true
  done
  echo
  echo "ports:"
  lsof -P -n -iTCP:"$HTTP_PORT" -iTCP:"$WS_PORT" -iUDP:"$UDP_PORT" 2>/dev/null | tail -n +2 || true
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "$ACTION" in
  help)
    print_help
    exit 0
    ;;
  status)
    print_status
    exit $?
    ;;
  stop)
    echo "→ Stopping sensing-server"
    stop_server
    echo "✓ Stopped"
    exit 0
    ;;
  restart)
    echo "→ Stopping any running sensing-server"
    stop_server || exit 1
    echo
    echo "→ Building (profile=$BUILD_PROFILE)"
    build_server || exit 2
    echo
    echo "→ Starting"
    start_server || exit 2
    echo
    echo "→ Verifying"
    verify_running || exit 3
    echo
    print_status
    echo
    echo "URLs:"
    echo "  http://localhost:$HTTP_PORT/ui/presence.html"
    echo "  http://localhost:$HTTP_PORT/ui/index.html"
    if [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
      ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
      [[ -n "$ip" ]] && echo "  http://$ip:$HTTP_PORT/ui/presence.html  (LAN)"
    fi
    exit 0
    ;;
esac
