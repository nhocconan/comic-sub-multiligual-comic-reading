#!/usr/bin/env bash
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  printf 'openssl is required.\n' >&2
  exit 1
fi

printf 'BONG_BONG_AUTH_KEY=%s\n' "$(openssl rand -hex 32)"
