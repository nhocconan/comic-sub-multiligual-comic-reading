#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${project_dir}/.runtime"
env_file="${project_dir}/.env"

mkdir -p "$runtime_dir"

if [[ ! -f "$env_file" ]]; then
  cp "${project_dir}/.env.example" "$env_file"
  printf 'Created %s. Add a Gemini or DeepSeek key when ready.\n' "$env_file"
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

runtime_mode="${RUNTIME_MODE:-auto}"
if [[ "$runtime_mode" == "auto" ]]; then
  if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
    runtime_mode="native"
  else
    runtime_mode="docker"
  fi
fi

find_native_koharu() {
  if [[ -n "${KOHARU_NATIVE_BINARY:-}" && -x "${KOHARU_NATIVE_BINARY}" ]]; then
    printf '%s\n' "${KOHARU_NATIVE_BINARY}"
    return
  fi
  if command -v koharu >/dev/null 2>&1; then
    command -v koharu
    return
  fi
  for candidate in \
    "/Applications/Koharu.app/Contents/MacOS/koharu" \
    "/Applications/Koharu.app/Contents/MacOS/Koharu"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

start_native() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'Native mode currently requires macOS.\n' >&2
    exit 1
  fi

  local binary
  binary="$(find_native_koharu || true)"
  if [[ -z "$binary" && "${INSTALL_KOHARU_IF_MISSING:-true}" == "true" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      printf 'Homebrew is required for automatic native Koharu installation.\n' >&2
      exit 1
    fi
    brew install --cask koharu
    binary="$(find_native_koharu || true)"
  fi
  if [[ -z "$binary" ]]; then
    printf 'Koharu native was not found. Install it or use RUNTIME_MODE=docker.\n' >&2
    exit 1
  fi

  if curl --fail --silent "http://127.0.0.1:4000/api/v1/meta" >/dev/null 2>&1; then
    printf 'Koharu is already listening on 127.0.0.1:4000.\n'
    return
  fi

  nohup "$binary" --port 4000 --headless \
    >"${runtime_dir}/koharu-native.log" 2>&1 &
  printf '%s\n' "$!" >"${runtime_dir}/koharu-native.pid"
}

start_docker() {
  if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
    printf '%s\n' \
      'Koharu 0.61.2 publishes only an amd64 container and crashes under Apple Silicon emulation.' \
      'Use RUNTIME_MODE=native on this machine.' >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    printf 'Docker Desktop is not running.\n' >&2
    exit 1
  fi
  docker compose --project-directory "$project_dir" \
    -f "${project_dir}/docker-compose.yml" up --detach
}

case "$runtime_mode" in
  native) start_native ;;
  docker) start_docker ;;
  *)
    printf 'RUNTIME_MODE must be auto, native, or docker.\n' >&2
    exit 1
    ;;
esac

ready=false
for _attempt in $(seq 1 120); do
  if curl --fail --silent "http://127.0.0.1:4000/api/v1/meta" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != "true" ]]; then
  printf 'Koharu did not become ready. Check %s/koharu-native.log or Docker logs.\n' \
    "$runtime_dir" >&2
  exit 1
fi

KOHARU_API_BASE="http://127.0.0.1:4000/api/v1" \
  "${project_dir}/scripts/configure-providers.sh"

broker_health="$(curl --silent --max-time 2 "http://127.0.0.1:4100/health" 2>/dev/null || true)"
if [[ "$broker_health" == *'"adapter":"explicit-test"'* ]]; then
  printf 'Port 4100 is running the explicit test broker. Stop it before starting Manga Sub.\n' >&2
  exit 1
fi
if [[ "$broker_health" != *'"adapter":"koharu"'* ]]; then
  nohup env \
    BROKER_HOST="127.0.0.1" \
    BROKER_PORT="4100" \
    BROKER_DATA_DIR="${runtime_dir}/broker-data" \
    KOHARU_ENDPOINT="http://127.0.0.1:4000/api/v1" \
    node "${project_dir}/services/broker/src/main.js" \
    >"${runtime_dir}/broker.log" 2>&1 &
  printf '%s\n' "$!" >"${runtime_dir}/broker.pid"
fi

broker_ready=false
for _attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:4100/health" | grep -q '"adapter":"koharu"'; then
    broker_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$broker_ready" != "true" ]]; then
  printf 'Manga Sub Broker did not become ready. Check %s/broker.log.\n' "$runtime_dir" >&2
  exit 1
fi

printf '%s\n' "$runtime_mode" >"${runtime_dir}/active-mode"

printf '\nManga Sub runtime is ready (%s).\n' "$runtime_mode"
printf 'Broker: http://127.0.0.1:4100 (Koharu adapter, no mock)\n'
printf 'Load the extension once from:\n%s/extension\n' "$project_dir"

if [[ "$(uname -s)" == "Darwin" && ! -f "${runtime_dir}/extension-folder-opened" ]]; then
  open "${project_dir}/extension"
  touch "${runtime_dir}/extension-folder-opened"
fi
