#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rehearsal_port="${1:-8788}"
if [[ ! "${rehearsal_port}" =~ ^[0-9]+$ ]] || (( rehearsal_port < 1024 || rehearsal_port > 65535 )); then
  echo "Use an unoccupied port from 1024 to 65535." >&2
  exit 1
fi

cd "${project_root}"
npm run build
mkdir -p "${project_root}/data"
rehearsal_dir="$(mktemp -d "${project_root}/data/rehearsal.XXXXXX")"
printf '\nStaged rehearsal: http://127.0.0.1:%s\nSeparate data: %s\nOpenAI disabled; leave delivery settings unconfigured. Ctrl+C stops this rehearsal.\n\n' "${rehearsal_port}" "${rehearsal_dir}"
exec env OPENAI_API_KEY='' RIPPLE_DATA_DIR="${rehearsal_dir}" PORT="${rehearsal_port}" npm start
