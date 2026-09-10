#!/usr/bin/env bash
# -------------------------------------------------------------------
# scripts/devbox/ops/check-local.sh — Validate local environment
# @version 3.0.0
# -------------------------------------------------------------------
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

dbx_detect_os
dbx_header "Local Environment Check"

# Git
if dbx_has git; then
  dbx_ok "git" "$(git --version)"
else
  dbx_fail "git" "not found"
fi

# Node
if dbx_has node; then
  dbx_ok "node" "$(node --version)"
else
  dbx_warn "node" "not found"
fi

# npm
if dbx_has npm; then
  dbx_ok "npm" "$(npm --version)"
else
  dbx_warn "npm" "not found"
fi

echo
echo "Local check complete."
