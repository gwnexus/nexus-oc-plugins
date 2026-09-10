#!/usr/bin/env bash
# -------------------------------------------------------------------
# scripts/devbox/ops/sec-scan.sh — Security & secrets scan
# @version 3.0.0
# -------------------------------------------------------------------
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

dbx_header "Security Scan"

# Check for common secret patterns in tracked files
echo "Scanning for potential secrets in tracked files..."

if dbx_has rg; then
  local_hits=$(rg -il --no-messages \
    '(PRIVATE.KEY|password\s*=|secret\s*=|api_key\s*=)' \
    --glob '!node_modules' --glob '!.git' --glob '!*.lock' \
    "${DBX_REPO_ROOT}" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${local_hits}" -gt 0 ]]; then
    dbx_warn "potential secrets" "${local_hits} file(s) with suspicious patterns"
  else
    dbx_ok "secrets scan" "no obvious patterns found"
  fi
else
  dbx_warn "ripgrep" "not available — skipping deep scan"
fi

echo
echo "Security scan complete."
