#!/usr/bin/env bash
# Server-side setup for the FLIR E8-XT edge collector on a Raspberry Pi.
#
# The Pi is the host that owns the camera and serves every endpoint in this repository, so this
# script installs what the collector needs *there*: system packages, a virtualenv with the Python
# requirements, access to /dev/video*, and optionally the systemd service that survives reboot.
#
#   ./deploy/setup_pi.sh --dry-run            # print the plan, change nothing
#   ./deploy/setup_pi.sh                      # dependencies + host verification
#   ./deploy/setup_pi.sh --install-service    # ...and enable flir-collector.service
#   ./deploy/setup_pi.sh --mount /media/pi/07F5-01A9/DCIM/100_FLIR
#
# Re-running it is safe: every step inspects the host first and only does what is missing.
#
# Flags:
#   --user NAME         account that owns the service (default: invoking user, or $SUDO_USER)
#   --port N            collector port (default: 8081)
#   --mount PATH        where this Pi sees the camera SD card
#                       (default: /media/<user>/07F5-01A9/DCIM/100_FLIR)
#   --venv DIR          virtualenv location (default: <repo>/venv, which is git-ignored)
#   --repo DIR          repository root (default: the parent of this script)
#   --install-service   render + install + enable deploy/flir-collector.service
#   --no-apt            skip apt-get (already provisioned hosts)
#   --dry-run           print commands instead of running them
#   -h | --help         this text
set -euo pipefail

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[xx]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Server-side setup for the FLIR E8-XT edge collector on a Raspberry Pi.

  ./deploy/setup_pi.sh [options]

  --user NAME         account that owns the service (default: invoking user, or $SUDO_USER)
  --port N            collector port (default: 8081)
  --mount PATH        where this Pi sees the camera SD card
                      (default: /media/<user>/07F5-01A9/DCIM/100_FLIR)
  --venv DIR          virtualenv location (default: <repo>/venv, which is git-ignored)
  --repo DIR          repository root (default: the parent of this script)
  --install-service   render + install + enable deploy/flir-collector.service
  --no-apt            skip apt-get (already provisioned hosts)
  --dry-run           print commands instead of running them
  -h | --help         this text
USAGE
}

DRY_RUN=0
DO_APT=1
INSTALL_SERVICE=0
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_USER="${SUDO_USER:-$(id -un)}"
PORT="8081"
VENV_DIR=""
MOUNT_PATH=""
SERVICE_NAME="flir-collector.service"

while [ $# -gt 0 ]; do
  case "$1" in
    --user)  TARGET_USER="${2:?--user needs a value}"; shift 2 ;;
    --port)  PORT="${2:?--port needs a value}"; shift 2 ;;
    --mount) MOUNT_PATH="${2:?--mount needs a value}"; shift 2 ;;
    --venv)  VENV_DIR="${2:?--venv needs a value}"; shift 2 ;;
    --repo)  REPO_DIR="${2:?--repo needs a value}"; shift 2 ;;
    --install-service) INSTALL_SERVICE=1; shift ;;
    --no-apt) DO_APT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$MOUNT_PATH" ] || MOUNT_PATH="/media/${TARGET_USER}/07F5-01A9/DCIM/100_FLIR"
[ -n "$VENV_DIR" ] || VENV_DIR="$REPO_DIR/venv"
[ -d "$REPO_DIR/edge_collector" ] || \
  die "$REPO_DIR does not look like the repository (no edge_collector/). Pass --repo DIR."
case "$PORT" in *[!0-9]*) die "--port must be a number, got: $PORT" ;; esac
[ "$PORT" -ge 1 ] || die "--port must be at least 1"
case "$VENV_DIR" in
  "$REPO_DIR"/*) VENV_REL="${VENV_DIR#"$REPO_DIR"/}" ;;
  *) die "--venv must live inside the repository ($REPO_DIR) so the systemd unit can reference it" ;;
esac

# sudo only when not already root, so the script also works from a root shell or a container.
SUDO=""
[ "$(id -u)" = "0" ] || SUDO="sudo"

# Every state-changing command goes through run(), which is what makes --dry-run honest.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

PY="$VENV_DIR/bin/python"
UNIT_SOURCE="$REPO_DIR/deploy/$SERVICE_NAME"
UNIT_TARGET="/etc/systemd/system/$SERVICE_NAME"
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
HOST_IP="${HOST_IP:-<pi-address>}"

log "Repository:   $REPO_DIR"
log "Service user: $TARGET_USER"
log "Virtualenv:   $VENV_DIR"
log "Camera mount: $MOUNT_PATH"
log "Collector:    http://0.0.0.0:$PORT"

# ---------------------------------------------------------------------------
# 1. System packages
#
#   python3-venv / python3-pip  - the collector runs from a virtualenv
#   libimage-exiftool-perl      - radiometric extraction shells out to exiftool
#   v4l-utils                   - v4l2-ctl supplies the pixel-format/control evidence the
#                                 capability probe reports (?capabilities=true)
#   libgl1 / libglib2.0-0 / libsm6 / libxext6 - what `import cv2` links against on a headless Pi
# ---------------------------------------------------------------------------
APT_PACKAGES="python3-venv python3-pip libimage-exiftool-perl v4l-utils libgl1 libglib2.0-0 libsm6 libxext6"

# 32-bit Raspberry Pi OS (armv7l) has no opencv-python wheel on PyPI: pip would try to build from
# source for hours on a Pi. Debian ships a working python3-opencv there, so use it and let the
# virtualenv see the system site-packages.
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|x86_64) OPENCV_FROM_APT=0 ;;
  *)              OPENCV_FROM_APT=1 ;;
esac

if [ "$DO_APT" = 1 ]; then
  log "System packages: $APT_PACKAGES"
  # shellcheck disable=SC2086
  run $SUDO apt-get update -qq
  # shellcheck disable=SC2086
  run $SUDO apt-get install -y $APT_PACKAGES
  if [ "$OPENCV_FROM_APT" = 1 ]; then
    warn "$ARCH has no opencv-python wheel on PyPI - installing Debian's python3-opencv instead"
    run $SUDO apt-get install -y python3-opencv
  fi
else
  log "Skipping apt-get (--no-apt)"
fi

# ---------------------------------------------------------------------------
# 2. Virtualenv + Python requirements
# ---------------------------------------------------------------------------
if [ -x "$PY" ]; then
  log "Virtualenv already present: $VENV_DIR"
elif [ "$OPENCV_FROM_APT" = 1 ]; then
  log "Creating virtualenv with --system-site-packages (so apt's python3-opencv is visible)"
  run python3 -m venv --system-site-packages "$VENV_DIR"
else
  log "Creating virtualenv: $VENV_DIR"
  run python3 -m venv "$VENV_DIR"
fi

REQUIREMENTS="$REPO_DIR/requirements.txt"
[ -f "$REQUIREMENTS" ] || die "requirements.txt not found in $REPO_DIR"

if [ "$OPENCV_FROM_APT" = 1 ]; then
  log "Installing requirements without opencv-python (cv2 comes from Debian's python3-opencv)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] grep -v opencv-python requirements.txt | %s -m pip install -r /dev/stdin\n' "$PY"
  else
    "$PY" -m pip install --upgrade pip setuptools wheel
    grep -v -i '^[[:space:]]*opencv-python' "$REQUIREMENTS" | "$PY" -m pip install -r /dev/stdin
  fi
else
  run "$PY" -m pip install --upgrade pip setuptools wheel
  run "$PY" -m pip install -r "$REQUIREMENTS"
fi

# ---------------------------------------------------------------------------
# 3. Host verification
#
# Nothing here changes state: it exists so the first HTTP request is not what discovers a missing
# ExifTool or an unreadable camera mount.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  log "Dry run: skipping host checks (import cv2, exiftool, v4l2-ctl, /dev/video*, camera mount)"
else
  log "Verifying the Python stack in $VENV_DIR"
  "$PY" - <<'PYCHECK'
import sys
import cv2
import numpy
import fastapi
import uvicorn
print("    python %s | cv2 %s | numpy %s | fastapi %s" % (
    sys.version.split()[0], cv2.__version__, numpy.__version__, fastapi.__version__))
PYCHECK

  if command -v exiftool >/dev/null 2>&1; then
    log "ExifTool $(exiftool -ver) found (radiometric extraction)"
  else
    warn "exiftool is not on PATH: album ingestion and /api/v1/thermal-frame cannot parse captures"
  fi

  if command -v v4l2-ctl >/dev/null 2>&1; then
    log "v4l2-ctl found (capability-probe evidence: pixel formats + controls)"
    v4l2-ctl --list-devices 2>/dev/null || warn "v4l2-ctl listed no capture devices"
  else
    warn "v4l2-ctl is missing: ?capabilities=true cannot list pixel formats or controls"
  fi

  VIDEO_NODES="$(ls /dev/video* 2>/dev/null || true)"
  if [ -n "$VIDEO_NODES" ]; then
    log "Video nodes: $(echo "$VIDEO_NODES" | tr '\n' ' ')"
  else
    warn "No /dev/video* node: MJPEG mode will answer HTTP 503. That is expected without a UVC"
    warn "  grabber - the E8-XT is a USB mass-storage instrument. Radiometric polling needs no"
    warn "  video hardware at all."
  fi

  if [ -d "$MOUNT_PATH" ]; then
    CAPTURES="$(find "$MOUNT_PATH" -maxdepth 1 -iname '*.jpg' 2>/dev/null | wc -l)"
    log "Camera mount present: $MOUNT_PATH holds $CAPTURES JPEG capture(s)"
    [ "$CAPTURES" -gt 0 ] || warn "  ...but no JPEGs: check the DCIM folder depth on the card"
  else
    warn "Camera mount $MOUNT_PATH does not exist. With the E8-XT plugged in, the Pi mounts the"
    warn "  card under /media/$TARGET_USER/<VOLUME>/ - what is there now:"
    ls -1 "/media/$TARGET_USER" 2>/dev/null | sed 's/^/      /' || \
      warn "      /media/$TARGET_USER is not present (no removable media mounted?)"
    warn "  Re-run with: --mount /media/$TARGET_USER/<VOLUME>/DCIM/100_FLIR"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Device permissions
#
# /dev/video* is root:video 0660, so a video device is invisible to the service account until it
# is in the video group.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = 0 ] && id -nG "$TARGET_USER" 2>/dev/null | tr ' ' '\n' | grep -qx video; then
  log "$TARGET_USER is already in the video group"
else
  log "Adding $TARGET_USER to the video group (device access for /dev/video*)"
  run $SUDO usermod -aG video "$TARGET_USER"
  [ "$DRY_RUN" = 1 ] || warn "$TARGET_USER must log out and back in (or reboot) before /dev/video* is readable"
fi

# ---------------------------------------------------------------------------
# 5. systemd service (server-side deploy: start on boot, restart on failure)
# ---------------------------------------------------------------------------
if [ "$INSTALL_SERVICE" = 1 ]; then
  [ -f "$UNIT_SOURCE" ] || die "unit template not found: $UNIT_SOURCE"

  render_unit() {
    sed -e "s|__USER__|$TARGET_USER|g" \
        -e "s|__REPO__|$REPO_DIR|g" \
        -e "s|__VENV__|$VENV_REL|g" \
        -e "s|__PORT__|$PORT|g" \
        -e "s|__MOUNT__|$MOUNT_PATH|g" \
        "$UNIT_SOURCE"
  }

  # A half-substituted unit would be installed happily and fail at boot, so check before writing.
  if render_unit | grep -q '__[A-Za-z_]*__'; then
    render_unit | grep -n '__[A-Za-z_]*__' >&2 || true
    die "deploy/$SERVICE_NAME still has unsubstituted placeholders (listed above)"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] install %s -> %s, then daemon-reload + enable --now\n' \
      "$UNIT_SOURCE" "$UNIT_TARGET"
    render_unit | sed 's/^/      | /'
  else
    log "Installing $UNIT_TARGET"
    render_unit | $SUDO tee "$UNIT_TARGET" >/dev/null
    $SUDO chmod 0644 "$UNIT_TARGET"
    if command -v systemd-analyze >/dev/null 2>&1; then
      $SUDO systemd-analyze verify "$UNIT_TARGET" \
        && log "systemd-analyze accepted the unit" \
        || warn "systemd-analyze reported an issue with the unit - review it above"
    fi
    run $SUDO systemctl daemon-reload
    run $SUDO systemctl enable --now "$SERVICE_NAME"
    $SUDO systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
    log "Logs: journalctl -u $SERVICE_NAME -f   |   Stop: sudo systemctl disable --now $SERVICE_NAME"
  fi
else
  log "Skipping the systemd service (--install-service installs and enables it)"
fi

# ---------------------------------------------------------------------------
# 6. What to do next
# ---------------------------------------------------------------------------
log "Setup finished. Start the collector with either:"
cat <<EOF
      $VENV_DIR/bin/python $REPO_DIR/edge_collector/main.py
      sudo systemctl start $SERVICE_NAME          # if --install-service was used
EOF
log "Then, from the workstation browser, point the pages at:"
cat <<EOF
      http://$HOST_IP:$PORT
      http://$HOST_IP:$PORT/api/v1/stream/devices?capabilities=true&read_test=true
EOF
log "The capability probe is the server-side answer to \"is this UVC after all?\": it reports the"
log "fourcc, the USB interface class behind /dev/videoN, and every format/control v4l2-ctl sees."

