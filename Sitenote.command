#!/bin/sh
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22.18 이상을 설치한 뒤 Sitenote.command를 다시 여세요.'
  exit 1
fi
exec node "$(dirname "$0")/scripts/launch-web.mjs" "$@"
