#!/usr/bin/env bash
# -------------------------------------------------------------------
# scripts/devbox/dbx_init.sh — DevBox initialization
# @version 3.0.0
# @purpose Detect environment, validate tooling, load OS overrides,
#          display status matrix.
# -------------------------------------------------------------------

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

# -------------------------------------------------------------------
# Metadata (injected by workspace template or devbox.json env vars)
# -------------------------------------------------------------------
: "${C_DBX_META_TEAM:=NEXUS-Labs}"
: "${C_DBX_META_TEAM_ID:=NEXUS-Labs-DD}"
: "${C_DBX_META_VERSION:=3.0.0}"
: "${C_DBX_SKIP_API_CHECKS:=true}"

# -------------------------------------------------------------------
# Status registry (bash 3.x compatible — parallel arrays)
# -------------------------------------------------------------------
_STATUS_KEYS=()
_STATUS_VALS=()

_record() { _STATUS_KEYS+=("$1"); _STATUS_VALS+=("${2}|${3}"); }  # key, code, note

_get_status() {
  local i
  for i in "${!_STATUS_KEYS[@]}"; do
    [[ "${_STATUS_KEYS[$i]}" == "$1" ]] && { echo "${_STATUS_VALS[$i]}"; return; }
  done
}

# -------------------------------------------------------------------
# Checks
# -------------------------------------------------------------------
check_core_tools() {
  for tool in git node npm jq; do
    if dbx_has "${tool}"; then
      _record "${tool}" ok "$(command -v "${tool}")"
    else
      _record "${tool}" fail "not found"
    fi
  done
}

check_npm_path() {
  if ! dbx_has npm; then
    _record "npm-path" warn "npm missing"
    return 0
  fi
  local npm_bin
  npm_bin="$(npm config get prefix 2>/dev/null)/bin"
  if [[ -d "${npm_bin}" && ":${PATH}:" != *":${npm_bin}:"* ]]; then
    export PATH="${npm_bin}:${PATH}"
  fi
  _record "npm-path" ok "global bin on PATH"
}

check_ai_tools() {
  # Claude CLI
  if dbx_has claude; then
    _record "claude-cli" ok "installed"
  else
    _record "claude-cli" warn "not found"
  fi

  # API keys
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && _record "anthropic-key" ok "present" || _record "anthropic-key" warn "missing"
  [[ -n "${OPENAI_API_KEY:-}" ]]    && _record "openai-key" ok "present"    || _record "openai-key" warn "missing (optional)"
  [[ -n "${GOOGLE_API_KEY:-}" ]]    && _record "gemini-key" ok "present"    || _record "gemini-key" warn "missing (optional)"

  # Taskmaster
  if dbx_has task-master; then
    _record "taskmaster" ok "installed"
  else
    _record "taskmaster" warn "not found"
  fi
}

check_dev_tools() {
  # GitHub CLI
  if dbx_has gh; then
    if gh auth status &>/dev/null; then
      _record "gh" ok "authenticated"
    else
      _record "gh" warn "unauthenticated"
    fi
  else
    _record "gh" warn "not found"
  fi

  # Ansible
  dbx_has ansible && _record "ansible" ok "on PATH" || _record "ansible" warn "not found"

  # Cursor
  if dbx_has cursor; then
    _record "cursor" ok "on PATH"
  elif [[ "${DBX_OS}" == "darwin" && -d "/Applications/Cursor.app" ]]; then
    _record "cursor" warn "use: open -a Cursor ."
  else
    _record "cursor" warn "not found"
  fi

  # Docker
  dbx_has docker && _record "docker" ok "available" || _record "docker" warn "not found"

  # tmux
  dbx_has tmux && _record "tmux" ok "available" || _record "tmux" warn "not found"
}

# -------------------------------------------------------------------
# Matrix renderer — shows ALL registered checks
# -------------------------------------------------------------------
print_matrix() {
  echo
  printf "${BLD}DevBox — %s/%s v%s${RST} [%s]\n" \
    "${C_DBX_META_TEAM}" "${C_DBX_META_TEAM_ID}" "${C_DBX_META_VERSION}" "${DBX_OS}"
  printf '%.0s─' {1..60}; echo
  printf "  ${BLD}%-16s %-4s %s${RST}\n" "Component" "St" "Notes"
  printf '%.0s─' {1..60}; echo

  # Deterministic display order
  local ordered_keys=(
    git node npm jq npm-path
    claude-cli anthropic-key openai-key gemini-key taskmaster
    gh ansible cursor docker tmux
    env.nexus.local
  )

  for key in "${ordered_keys[@]}"; do
    local val
    val="$(_get_status "${key}")"
    [[ -z "${val}" ]] && continue
    local code note
    IFS='|' read -r code note <<< "${val}"
    case "${code}" in
      ok)   printf "  %-16s ${C_GRN}%-4s${RST} %s\n" "${key}" "$(dbx_icon ok)" "${note}" ;;
      warn) printf "  %-16s ${C_YLW}%-4s${RST} %s\n" "${key}" "$(dbx_icon warn)" "${note}" ;;
      fail) printf "  %-16s ${C_RED}%-4s${RST} %s\n" "${key}" "$(dbx_icon fail)" "${note}" ;;
    esac
  done
  printf '%.0s─' {1..60}; echo
}

# -------------------------------------------------------------------
# Help
# -------------------------------------------------------------------
print_help() {
  printf "\n${BLD}${C_BLU}Available Commands${RST}\n"
  printf "  %-18s %s\n" "check-local" "validate local environment"
  printf "  %-18s %s\n" "validate" "validate repo structure + syntax"
  printf "  %-18s %s\n" "sec-scan" "security & secrets scan"
  printf "  %-18s %s\n" "tmux-2w" "launch 2-pane tmux session"
  printf "  %-18s %s\n" "tmux-3w" "launch 3-pane tmux session"
  echo
  printf "  Usage: ${DIM}devbox run <command>${RST}\n\n"
}

# -------------------------------------------------------------------
# .env.nexus.local — Nexus environment file check
# -------------------------------------------------------------------
check_nexus_env() {
  local env_file="${DBX_REPO_ROOT}/.env.nexus.local"
  if [[ -f "${env_file}" ]]; then
    # shellcheck source=/dev/null
    source "${env_file}"
    _record "env.nexus.local" ok "loaded"
  else
    _record "env.nexus.local" warn "not found (optional)"
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------
dbx_detect_os
check_npm_path
check_core_tools
check_ai_tools
check_dev_tools
check_nexus_env
dbx_load_os_override

print_matrix
print_help
