#!/usr/bin/env bash
# 安装 wiki CLI 到 PATH（软链，保留脚本原位）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$DIR/wiki.mjs"
ln -sf "$DIR/wiki.mjs" /usr/local/bin/wiki
echo "wiki CLI 已安装: $(which wiki)"
wiki --help 2>/dev/null || true
