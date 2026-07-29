#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${project_dir}/.runtime"
pid_file="${runtime_dir}/koharu-native.pid"

if [[ -f "$pid_file" ]]; then
  pid="$(tr -cd '0-9' <"$pid_file")"
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ -n "$pid" ]] && printf '%s' "$command_line" | grep -qi 'koharu'; then
    kill "$pid"
    for _attempt in $(seq 1 20); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    printf 'Stopped native Koharu.\n'
  fi
  rm -f "$pid_file"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose --project-directory "$project_dir" \
    -f "${project_dir}/docker-compose.yml" down --remove-orphans
fi

rm -f "${runtime_dir}/active-mode"
printf 'Comic Sub runtime is stopped. Model and credential volumes were preserved.\n'
