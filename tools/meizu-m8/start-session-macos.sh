#!/bin/sh
set -eu

if [ "${1:-}" = "--pppd-supervisor" ]; then
  PTY=$2
  PPPD_LOG=$3
  SERIAL_CHAT=$4
  STOP_FILE=$5
  rm -f "$STOP_FILE"
  /usr/sbin/pppd "$PTY" 115200 nodetach nodefaultroute local noauth crtscts \
    debug linkname pocketjs-meizu-m8 \
    192.168.131.1:192.168.131.129 ms-dns 192.168.131.1 \
    connect "$SERIAL_CHAT" logfile "$PPPD_LOG" &
  PPPD_PID=$!
  stop_pppd() {
    for child_pid in $(/usr/bin/pgrep -P "$PPPD_PID" 2>/dev/null || true); do
      kill "$child_pid" 2>/dev/null || true
    done
    kill "$PPPD_PID" 2>/dev/null || true
    stop_attempt=0
    while kill -0 "$PPPD_PID" 2>/dev/null && [ "$stop_attempt" -lt 3 ]; do
      stop_attempt=$((stop_attempt + 1))
      sleep 1
    done
    if kill -0 "$PPPD_PID" 2>/dev/null; then
      for child_pid in $(/usr/bin/pgrep -P "$PPPD_PID" 2>/dev/null || true); do
        kill -KILL "$child_pid" 2>/dev/null || true
      done
      kill -KILL "$PPPD_PID" 2>/dev/null || true
    fi
  }
  trap stop_pppd EXIT INT TERM
  while kill -0 "$PPPD_PID" 2>/dev/null; do
    if [ -f "$STOP_FILE" ]; then
      stop_pppd
    fi
    sleep 1
  done
  wait "$PPPD_PID"
  exit $?
fi

PTY=$1
CACHE_ROOT=$2
if ! printf '%s\n' "$PTY" | grep -Eq '^/dev/ttys[0-9]+$'; then
  echo "expected a /dev/ttysNNN bridge path" >&2
  exit 2
fi

RUN_DIR="$CACHE_ROOT/run"
DBUS_SOCKET="$RUN_DIR/dbus-$$.sock"
DBUS_LOG="$RUN_DIR/dbus.log"
DCCM_LOG="$RUN_DIR/dccm.log"
PPPD_LOG="$RUN_DIR/pppd.log"
DBUS_ADDRESS_FILE="$RUN_DIR/dbus-address"
PPPD_STOP_FILE="$RUN_DIR/pppd-stop-$$"
DCCM="$CACHE_ROOT/host/libexec/dccm"
mkdir -p "$RUN_DIR"
rm -f "$PPPD_STOP_FILE"

osascript - "$PTY" "$PPPD_LOG" "$CACHE_ROOT/host/libexec/synce-serial-chat" \
  "$0" "$PPPD_STOP_FILE" <<'APPLESCRIPT' &
on run arguments
  set ptyPath to item 1 of arguments
  set logPath to item 2 of arguments
  set serialChat to item 3 of arguments
  set supervisor to item 4 of arguments
  set stopPath to item 5 of arguments
  set pppCommand to "/bin/sh " & quoted form of supervisor & " --pppd-supervisor " & quoted form of ptyPath & " " & quoted form of logPath & " " & quoted form of serialChat & " " & quoted form of stopPath
  do shell script pppCommand with administrator privileges
end run
APPLESCRIPT
PPPD_LAUNCHER_PID=$!

DBUS_OUTPUT=$(dbus-daemon \
  --session \
  --address="unix:path=$DBUS_SOCKET" \
  --fork \
  --print-address=1 \
  --print-pid=1 2>"$DBUS_LOG")
DBUS_ADDRESS=$(printf '%s\n' "$DBUS_OUTPUT" | sed -n '1p')
DBUS_PID=$(printf '%s\n' "$DBUS_OUTPUT" | sed -n '2p')
DBUS_SYSTEM_BUS_ADDRESS=$DBUS_ADDRESS "$DCCM" \
  --foreground --log-level=6 >"$DCCM_LOG" 2>&1 &
DCCM_PID=$!
cleanup() {
  : >"$PPPD_STOP_FILE"
  kill "$DCCM_PID" "$DBUS_PID" 2>/dev/null || true
  attempt=0
  while kill -0 "$PPPD_LAUNCHER_PID" 2>/dev/null && \
    [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    sleep 1
  done
  kill "$PPPD_LAUNCHER_PID" 2>/dev/null || true
  rm -f "$PPPD_STOP_FILE"
  if [ -f "$DBUS_ADDRESS_FILE" ] && \
    [ "$(cat "$DBUS_ADDRESS_FILE")" = "$DBUS_ADDRESS" ]; then
    rm -f "$DBUS_ADDRESS_FILE"
  fi
}
trap cleanup EXIT INT TERM

attempt=0
until DBUS_SYSTEM_BUS_ADDRESS=$DBUS_ADDRESS gdbus call --system \
  --dest org.synce.dccm \
  --object-path /org/synce/dccm/DeviceManagerControl \
  --method org.synce.dccm.DeviceManager.Control.DeviceConnected \
  meizu-m8-usb 192.168.131.129 192.168.131.1 false >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "SynCE DCCM did not register on its private D-Bus" >&2
    exit 1
  fi
  sleep 1
done
umask 077
printf '%s\n' "$DBUS_ADDRESS" >"$DBUS_ADDRESS_FILE"

find_pocketjs_ppp_interface() {
  for interface in $(ifconfig -l); do
    case "$interface" in
      ppp*)
        if ifconfig "$interface" 2>/dev/null | \
          grep -q 'inet 192\.168\.131\.1'; then
          printf '%s\n' "$interface"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

attempt=0
PPP_INTERFACE=""
while [ -z "$PPP_INTERFACE" ]; do
  PPP_INTERFACE=$(find_pocketjs_ppp_interface || true)
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "PPP did not negotiate within 120 seconds; see $PPPD_LOG" >&2
    exit 1
  fi
  sleep 1
done

attempt=0
while ! DBUS_SYSTEM_BUS_ADDRESS=$DBUS_ADDRESS gdbus call --system \
  --dest org.synce.dccm \
  --object-path /org/synce/dccm/DeviceManager \
  --method org.synce.dccm.DeviceManager.GetConnectedDevices 2>/dev/null | \
  grep -q '/org/synce/dccm/Device'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "M8 did not open its SynCE control connection within 60 seconds" >&2
    exit 1
  fi
  sleep 1
done

echo "PocketJS Meizu M8: PPP and SynCE are connected on $PPP_INTERFACE"
echo "PocketJS Meizu M8: keep this terminal open during deploy"
wait "$DCCM_PID"
