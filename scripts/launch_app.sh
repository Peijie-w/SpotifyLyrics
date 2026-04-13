#!/bin/zsh

set -euo pipefail

PROJECT_DIR="/Users/peijiewang/Documents/spotify"
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG_FILE="${TMPDIR:-/tmp}/spotify-floating-lyrics.log"
PROCESS_PATTERN="$PROJECT_DIR/node_modules/.bin/electron|$PROJECT_DIR|spotify-floating-lyrics"

if [[ ! -x "$ELECTRON_BIN" ]]; then
  osascript -e 'display dialog "启动失败：没有找到 Electron 运行文件，请先确保项目依赖已安装。" buttons {"好"} default button "好" with icon caution'
  exit 1
fi

pkill -f "$PROCESS_PATTERN" >/dev/null 2>&1 || true
nohup "$ELECTRON_BIN" "$PROJECT_DIR" >>"$LOG_FILE" 2>&1 &
