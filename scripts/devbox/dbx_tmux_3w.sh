#!/usr/bin/env bash
# -------------------------------------------------------------------
# scripts/devbox/dbx_tmux_3w.sh — Launch 3-pane tmux session
# @version 3.0.0
# -------------------------------------------------------------------
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

: "${C_DBX_INIT_SESSION_NAME_3W:=dbx-3w}"
: "${C_DBX_INIT_SESSION_FILE_MARKER:=${DBX_SCRIPTS_ROOT}/.tmux-active}"

if tmux has-session -t "${C_DBX_INIT_SESSION_NAME_3W}" 2>/dev/null; then
  echo "DevBox tmux session [${C_DBX_INIT_SESSION_NAME_3W}] already exists."
  echo "Type 'exit' in all panes to return to the normal devbox shell."
  exit 0
fi

touch "${C_DBX_INIT_SESSION_FILE_MARKER}"
echo "Launching tmux session [${C_DBX_INIT_SESSION_NAME_3W}] ..."
tmuxp load "${DBX_SCRIPTS_ROOT}/init/tmuxp_3w.yaml"
rm -f "${C_DBX_INIT_SESSION_FILE_MARKER}"
echo "Session [${C_DBX_INIT_SESSION_NAME_3W}] closed."
