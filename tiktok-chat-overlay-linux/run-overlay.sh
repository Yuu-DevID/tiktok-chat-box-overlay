#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/tiktok-chat-overlay"

# On Wayland sessions, GTK/WebKit2GTK is more reliable via XWayland for this app.
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "${GDK_BACKEND:-}" ]; then
  export GDK_BACKEND=x11
fi

# Prefer system WebKit libs/helpers. Only fall back to Flatpak runtime if missing.
if [ ! -e /usr/lib/libwebkit2gtk-4.1.so.0 ] && [ ! -e /usr/lib64/libwebkit2gtk-4.1.so.0 ]; then
  FLATPAK_WEBKIT_LIB="/var/lib/flatpak/runtime/org.gnome.Platform/x86_64/51/96a0ec96d06a8df1df432178b1483e920c728927761375a916644b6f0e0e5547/files/lib/x86_64-linux-gnu"
  if [ -d "$FLATPAK_WEBKIT_LIB" ]; then
    export LD_LIBRARY_PATH="$FLATPAK_WEBKIT_LIB:${LD_LIBRARY_PATH:-}"
  fi
fi

# Point to helper processes if not in default locations.
if [ -z "${WEBKIT_EXEC_PATH:-}" ]; then
  if [ -d "/usr/lib/webkit2gtk-4.1" ]; then
    export WEBKIT_EXEC_PATH="/usr/lib/webkit2gtk-4.1"
  elif [ -d "/usr/libexec/webkit2gtk-4.1" ]; then
    export WEBKIT_EXEC_PATH="/usr/libexec/webkit2gtk-4.1"
  elif [ -d "/var/lib/flatpak/runtime/org.gnome.Platform/x86_64/51/96a0ec96d06a8df1df432178b1483e920c728927761375a916644b6f0e0e5547/files/libexec/webkit2gtk-4.1" ]; then
    export WEBKIT_EXEC_PATH="/var/lib/flatpak/runtime/org.gnome.Platform/x86_64/51/96a0ec96d06a8df1df432178b1483e920c728927761375a916644b6f0e0e5547/files/libexec/webkit2gtk-4.1"
  fi
fi

export CHATBOX_URL="${CHATBOX_URL:-http://localhost:8080/chatbox}"
exec "$BIN" "$@"