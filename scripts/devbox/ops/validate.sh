#!/usr/bin/env bash
# -------------------------------------------------------------------
# scripts/devbox/ops/validate.sh — Validate repo structure + syntax
# @version 3.0.0
# -------------------------------------------------------------------
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

dbx_header "Repo Validation"

# Check required files
for f in package.json tsconfig.json; do
  if [[ -f "${DBX_REPO_ROOT}/${f}" ]]; then
    dbx_ok "${f}" "found"
  else
    dbx_warn "${f}" "missing"
  fi
done

echo
echo "Validation complete."
