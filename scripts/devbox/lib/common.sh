#!/usr/bin/env bash
# -------------------------------------------------------------------
# scripts/devbox/lib/common.sh — Shared library for devbox scripts
# @version 3.0.0
# -------------------------------------------------------------------
# Source this file; do NOT execute directly.
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
# -------------------------------------------------------------------

# Guard against double-sourcing
[[ -n "${_DBX_LIB_COMMON_LOADED:-}" ]] && return 0
_DBX_LIB_COMMON_LOADED=1

# -------------------------------------------------------------------
# Resolve repo root (works from any script location)
# -------------------------------------------------------------------
DBX_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../" && pwd)"
DBX_SCRIPTS_ROOT="${DBX_REPO_ROOT}/scripts/devbox"

# -------------------------------------------------------------------
# Color & formatting (respects NO_COLOR / DBX_NO_COLOR)
# -------------------------------------------------------------------
if [[ "${NO_COLOR:-${DBX_NO_COLOR:-0}}" == "1" ]]; then
  RST="" BLD="" DIM=""
  C_RED="" C_GRN="" C_YLW="" C_BLU="" C_CYN="" C_GRY=""
else
  RST='\033[0m' BLD='\033[1m' DIM='\033[2m'
  C_RED='\033[31m' C_GRN='\033[32m' C_YLW='\033[33m'
  C_BLU='\033[34m' C_CYN='\033[36m' C_GRY='\033[90m'
fi

# -------------------------------------------------------------------
# Icon set (ascii | ticks | blocks)
# -------------------------------------------------------------------
: "${DBX_ICON_SET:=ticks}"

dbx_icon() {
  case "${DBX_ICON_SET}:${1}" in
    ascii:ok)   printf "OK"  ;; ascii:fail) printf "ERR" ;; ascii:warn) printf "WRN" ;;
    ticks:ok)   printf "✓"   ;; ticks:fail) printf "✗"   ;; ticks:warn) printf "⚠"   ;;
    blocks:ok)  printf "■"   ;; blocks:fail)printf "■"   ;; blocks:warn)printf "■"   ;;
    *)          printf "%s" "$1" ;;
  esac
}

# -------------------------------------------------------------------
# Output helpers
# -------------------------------------------------------------------
dbx_ok()   { printf "  ${C_GRN}$(dbx_icon ok)${RST} %-30s %s\n" "$1" "${2:-}"; }
dbx_warn() { printf "  ${C_YLW}$(dbx_icon warn)${RST} %-30s %s\n" "$1" "${2:-}"; }
dbx_fail() { printf "  ${C_RED}$(dbx_icon fail)${RST} %-30s %s\n" "$1" "${2:-}"; }
dbx_header() { printf "\n${BLD}${C_BLU}%s${RST}\n${DIM}%s${RST}\n" "$1" "$(printf '%.0s─' {1..60})"; }
dbx_die()  { printf "${C_RED}${BLD}ERROR:${RST} %s\n" "$*" >&2; exit 1; }

# -------------------------------------------------------------------
# OS detection (sets DBX_OS)
# -------------------------------------------------------------------
dbx_detect_os() {
  local uname_out
  uname_out="$(uname -a)"
  case "${uname_out}" in
    *Microsoft*)  DBX_OS="wsl"     ;;
    *microsoft*)  DBX_OS="wsl"     ;;
    Linux*)       DBX_OS="linux"   ;;
    Darwin*)      DBX_OS="darwin"  ;;
    CYGWIN*)      DBX_OS="win64"   ;;
    MINGW*|*Msys) DBX_OS="win64"   ;;
    *)            DBX_OS="unknown" ;;
  esac
  export DBX_OS
}

# -------------------------------------------------------------------
# OS-override loader
# Looks for scripts/devbox/init/os_<DBX_OS>/override.sh and sources it
# -------------------------------------------------------------------
dbx_load_os_override() {
  local override_path="${DBX_SCRIPTS_ROOT}/init/os_${DBX_OS}/override.sh"
  if [[ -f "${override_path}" ]]; then
    # shellcheck source=/dev/null
    source "${override_path}"
  fi
}

# -------------------------------------------------------------------
# Command availability check (simple wrapper)
# -------------------------------------------------------------------
dbx_has() { command -v "$1" &>/dev/null; }
