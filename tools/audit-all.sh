#!/usr/bin/env bash
# tools/audit-all.sh — Test-All master diagnostic (LOCAL EMULATOR ONLY)
#
#   bash tools/audit-all.sh
#
# Steps:
#   0. Preflight   tools + teacher-tests dependencies, emulators reachable
#   1. Provision   node tools/seed_accounts.js
#   2. Rules       node --test tools/rules-audit.spec.js
#   3. E2E smoke   npx playwright test smoke.spec.js   (teacher-tests/)
#   4. Teardown    node tools/seed_accounts.js --cleanup   (always runs)
#
# Exit 0 + "[TRUE] ALL SYSTEMS GO" only when every step passes.

set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
export FIREBASE_AUTH_EMULATOR_HOST="${FIREBASE_AUTH_EMULATOR_HOST:-127.0.0.1:9099}"
export DIAG_PROJECT_ID="${DIAG_PROJECT_ID:-dev-school-grade-tracker}"
unset GOOGLE_APPLICATION_CREDENTIALS

if [ -t 1 ]; then
  GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; CYAN=$'\033[1;36m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=''; RED=''; CYAN=''; DIM=''; RESET=''
fi

STEP_NAMES=()
STEP_CODES=()
OVERALL=0

run_step() {
  local name="$1"; shift
  echo
  echo "${CYAN}==> ${name}${RESET}"
  echo "${DIM}\$ $*${RESET}"
  "$@"
  local code=$?
  STEP_NAMES+=("$name")
  STEP_CODES+=("$code")
  [ "$code" -ne 0 ] && OVERALL=1
  return "$code"
}

skip_step() {
  STEP_NAMES+=("$1")
  STEP_CODES+=("SKIP")
  OVERALL=1
}

preflight() {
  local ok=0
  for host in "$FIRESTORE_EMULATOR_HOST" "$FIREBASE_AUTH_EMULATOR_HOST"; do
    case "$host" in
      127.0.0.1:*|localhost:*|\[::1\]:*) ;;
      *) echo "${RED}Refusing: emulator host '$host' is not loopback.${RESET}"; return 2 ;;
    esac
    if ! node -e "fetch('http://$host/',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
      echo "${RED}Emulator not reachable at $host. Start it first: npm run emulators${RESET}"
      ok=1
    fi
  done
  [ "$ok" -ne 0 ] && return 1

  if [ ! -d tools/node_modules ]; then
    npm --prefix tools install --no-audit --no-fund || return 1
  fi
  if [ ! -d teacher-tests/node_modules ]; then
    npm --prefix teacher-tests install --no-audit --no-fund || return 1
  fi
  echo "emulators: firestore=$FIRESTORE_EMULATOR_HOST auth=$FIREBASE_AUTH_EMULATOR_HOST project=$DIAG_PROJECT_ID"
  return 0
}

e2e_smoke() {
  ( cd teacher-tests && npx playwright test smoke.spec.js )
}

# ── Run ─────────────────────────────────────────────────────────────────────
if run_step "Preflight" preflight; then
  if run_step "Provision test accounts" node tools/seed_accounts.js; then
    run_step "Rules RBAC audit" node --test tools/rules-audit.spec.js
    run_step "Web E2E smoke" e2e_smoke
  else
    skip_step "Rules RBAC audit"
    skip_step "Web E2E smoke"
  fi
  run_step "Teardown test accounts" node tools/seed_accounts.js --cleanup
else
  skip_step "Provision test accounts"
  skip_step "Rules RBAC audit"
  skip_step "Web E2E smoke"
  skip_step "Teardown test accounts"
fi

# ── Report ──────────────────────────────────────────────────────────────────
echo
echo "------------------------------------------------------------"
for i in "${!STEP_NAMES[@]}"; do
  code="${STEP_CODES[$i]}"
  if [ "$code" = "0" ]; then
    printf "  ${GREEN}PASS${RESET}  %s\n" "${STEP_NAMES[$i]}"
  elif [ "$code" = "SKIP" ]; then
    printf "  ${RED}SKIP${RESET}  %s\n" "${STEP_NAMES[$i]}"
  else
    printf "  ${RED}FAIL${RESET}  %s (exit %s)\n" "${STEP_NAMES[$i]}" "$code"
  fi
done
echo "------------------------------------------------------------"
echo
if [ "$OVERALL" -eq 0 ]; then
  echo "${GREEN}############################################################${RESET}"
  echo "${GREEN}##                 [TRUE] ALL SYSTEMS GO                  ##${RESET}"
  echo "${GREEN}############################################################${RESET}"
  exit 0
else
  echo "${RED}############################################################${RESET}"
  echo "${RED}##              [FALSE] DIAGNOSTIC FAILED                 ##${RESET}"
  echo "${RED}############################################################${RESET}"
  exit 1
fi
