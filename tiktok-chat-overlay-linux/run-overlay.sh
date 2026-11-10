#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/tiktok-chat-overlay"

# Prefer system libs; fall back to Flatpak GNOME runtime webkit/gtk libs if present (CachyOS/Arch setups).
FLATPAK_WEBKIT_LIB="/var/lib/flatpak/runtime/org.gnome.Platform/x86_64/51/96a0ec96d06a8df1df432178b1483e920c728927761375a916644b6f0e0e5547/files/lib/x86_64-linux-gnu"
FLATPAK_WEBKIT_EXEC="/var/lib/flatpak/runtime/org.gnome.Platform/x86_64/51/96a0ec96d06a8df1df432178b1483e920c728927761375a916644b6f0e0e5547/files/libexec/webkit2gtk-4.1"

if [ -d "$FLATPAK_WEBKIT_LIB" ] && [ ! -e /usr/lib/libwebkit2gtk-4.1.so.0 ]; then
  export LD_LIBRARY_PATH="$FLATPAK_WEBKIT_LIB:${LD_LIBRARY_PATH:-}"
fi
if [ -d "$FLATPAK_WEBKIT_EXEC" ]; then
  export WEBKIT_EXEC_PATH="${WEBKIT_EXEC_PATH:-$FLATPAK_WEBKIT_EXEC}"
fi

# On Wayland sessions, forcing X11 (XWayland) can improve compatibility for frameless transparent webviews.
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "${GDK_BACKEND:-}" ]; then
  export GDK_BACKEND=x11
fi

export CHATBOX_URL="${CHATBOX_URL:-http://localhost:8080/chatbox}"
exec "$BIN" "$@"

# Attempt WebKit helper path override if installed in non-standard location
if [ -d "/usr/libexec/webkit2gtk-4.1" ]; then
  export WEBKIT_EXEC_PATH="${WEBKIT_EXEC_PATH:-/usr/libexec/webkit2gtk-4.1}"
elif [ -d "/usr/lib/webkit2gtk-4.1" ]; then
  export WEBKIT_EXEC_PATH="${WEBKIT_EXEC_PATH:-/usr/lib/webkit2gtk-4.1}"
fi
