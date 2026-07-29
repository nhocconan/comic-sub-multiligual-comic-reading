#!/usr/bin/env bash
set -euo pipefail

api_base="${KOHARU_API_BASE:-http://127.0.0.1:4000/api/v1}"

store_secret() {
  local provider_id="$1"
  local secret="$2"
  if [[ -z "$secret" ]]; then
    return
  fi

  KOHARU_PROVIDER_SECRET="$secret" node -e \
    'process.stdout.write(JSON.stringify({secret: process.env.KOHARU_PROVIDER_SECRET}))' |
    curl --fail --silent --show-error \
      --request PUT \
      --header "Content-Type: application/json" \
      --data-binary @- \
      "${api_base}/config/providers/${provider_id}/secret" >/dev/null
  printf 'Configured %s in Koharu credential storage.\n' "$provider_id"
}

store_secret "gemini" "${GEMINI_API_KEY:-}"
store_secret "deepseek" "${DEEPSEEK_API_KEY:-}"
store_secret "openai" "${OPENAI_API_KEY:-}"
store_secret "claude" "${CLAUDE_API_KEY:-}"
