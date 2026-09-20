#!/usr/bin/env bash
set -euo pipefail

# Pinned native CLI for the local demo. This script does not log in or call Partiful.
version="3.0.1"
archive="partiful_${version}_darwin_arm64.tar.gz"
release_url="https://github.com/KalebCole/partiful-cli/releases/download/v${version}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools_dir="${project_root}/.tools"
bundle_dir="${tools_dir}/partiful-v${version}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This pinned setup supports macOS ARM64 only." >&2
  exit 1
fi

mkdir -p "${bundle_dir}"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  "${release_url}/${archive}" --output "${bundle_dir}/${archive}"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  "${release_url}/partiful_${version}_checksums.txt" --output "${bundle_dir}/checksums.txt"

expected_sha="$(awk -v archive="${archive}" '$2 == archive {print $1}' "${bundle_dir}/checksums.txt")"
actual_sha="$(shasum -a 256 "${bundle_dir}/${archive}" | awk '{print $1}')"
if [[ ! "${expected_sha}" =~ ^[a-f0-9]{64}$ || "${actual_sha}" != "${expected_sha}" ]]; then
  echo "Partiful release checksum verification failed; nothing was installed." >&2
  exit 1
fi

# Keep the archive, official checksums, README, and license with the installed binary.
tar -xzf "${bundle_dir}/${archive}" -C "${bundle_dir}"
install -m 755 "${bundle_dir}/partiful_${version}_darwin_arm64/partiful" "${tools_dir}/partiful"
printf 'Verified SHA-256: %s\nInstalled: %s\n' "${actual_sha}" "${tools_dir}/partiful"
