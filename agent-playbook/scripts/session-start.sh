#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions: leaves the session ready to run the tests and
# the build. Idempotent and non-interactive: a step that is already done is not repeated, because
# the hook runs again on every resume.
#
# 1. Node: the exact version in .node-version, downloaded from nodejs.org and checked against the
#    release's SHASUMS256.txt before it is unpacked. The image's Node is used when it already matches.
# 2. Extra variables the project's tools need (EXTRA_ENV below). Configuration only, never a
#    credential: whatever is written here is readable by every command of the session.
# 3. .cache/session-env.sh with the same lines, for shells that do not read the session's env file
#    (subagents, and every Bash call of a subagent): `source .cache/session-env.sh && npm test`.
# 4. npm ci only when package-lock.json, .node-version or this script changed since the last run.
#
# Outside a cloud session it does nothing. By hand: CLAUDE_PROJECT_DIR=<repo root> CLAUDE_CODE_REMOTE=true bash scripts/session-start.sh
set -euo pipefail

[[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]] || exit 0
# This script's own path, taken before the cd, so the stamp works wherever the project keeps it.
self="$(realpath "${BASH_SOURCE[0]}")"
cd "${CLAUDE_PROJECT_DIR:?}"

# Lines such as 'export TOOL_MODE=local'. Empty by default; add what the project's tools need.
EXTRA_ENV=()

lines=()
# Keeps the line for .cache/session-env.sh and adds it to the session's env file once.
persist() {
  lines+=("$1")
  [[ -n "${CLAUDE_ENV_FILE:-}" ]] || return 0
  grep -qxF -- "$1" "$CLAUDE_ENV_FILE" 2>/dev/null || echo "$1" >> "$CLAUDE_ENV_FILE"
}

# --- 1. Node -----------------------------------------------------------------
want="v$(tr -d ' \n\r' < .node-version)"
if [[ "$(node --version 2>/dev/null || true)" != "$want" ]]; then
  case "$(uname -m)" in
    x86_64) arch="linux-x64" ;;
    aarch64 | arm64) arch="linux-arm64" ;;
    *) echo "session-start: no Node build for $(uname -m)" >&2; exit 1 ;;
  esac
  dir="${XDG_CACHE_HOME:-$HOME/.cache}/node/${want}-${arch}"
  if [[ ! -x "$dir/bin/node" ]]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    file="node-${want}-${arch}.tar.xz"
    curl -fsSL --retry 3 -o "$tmp/$file" "https://nodejs.org/dist/${want}/${file}"
    curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/${want}/SHASUMS256.txt"
    # grep fails when the file is not listed, and sha256sum when it does not match: either stops here.
    (cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | sha256sum -c --status -)
    mkdir -p "$(dirname "$dir")"
    tar -xJf "$tmp/$file" -C "$tmp"
    rm -rf "$dir" && mv "$tmp/node-${want}-${arch}" "$dir"
  fi
  export PATH="$dir/bin:$PATH"
fi
# Always persisted: on a resume the shell may already have the right Node, and the file for
# subagents still has to carry it.
persist "export PATH=\"$(dirname "$(command -v node)"):\$PATH\""

# --- 2. Extra variables --------------------------------------------------------
for line in "${EXTRA_ENV[@]}"; do persist "$line"; done

# --- 3. Environment for other shells -------------------------------------------
# Written before npm ci: if the install fails, the right Node is already at hand to look into it.
mkdir -p .cache
{
  echo "# Written by the session start hook. Use: source .cache/session-env.sh"
  printf '%s\n' "${lines[@]}"
} > .cache/session-env.sh

# --- 4. Dependencies -----------------------------------------------------------
stamp="node_modules/.session-start.sha256"
if ! sha256sum --check --status "$stamp" 2>/dev/null; then
  rm -f "$stamp"
  npm ci --no-audit --no-fund --loglevel=error
  sha256sum package-lock.json .node-version "$self" > "$stamp"
fi

echo "Session ready: Node $(node --version), dependencies up to date."
