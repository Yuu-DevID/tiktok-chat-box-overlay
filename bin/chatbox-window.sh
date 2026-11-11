#!/usr/bin/env bash
# Open the chat window as its own desktop window (Brave/Chrome app mode), so
# KDE's "Keep Above Others" can pin it over gameplay.
#
# Usage: bin/chatbox-window.sh [extra app args]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${TIKTOK_READER_BIN:-$ROOT/tiktok-chat-overlay-linux/tiktok-chat-overlay}"
if [ ! -x "$BIN" ]; then
  BIN="$ROOT/rust/target/release/tiktok-live-reader"
fi
if [ ! -x "$BIN" ]; then
  echo "Build the app first: cd rust && cargo build --release" >&2
  exit 1
fi
exec "$BIN" --view chatbox "$@"
