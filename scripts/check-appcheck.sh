#!/usr/bin/env bash
# scripts/check-appcheck.sh — App Check enforcement deploy gate.
#
# There is no `gcloud firebase appcheck` command group (gcloud 576.0.0 only
# exposes `gcloud firebase test` / Firebase Test Lab — verified via
# `gcloud firebase --help` and `gcloud beta firebase --help`) and no
# `firebase appcheck:*` command in firebase-tools (verified against 14.27.0:
# `firebase --help` lists zero "appcheck" commands). App Check enforcement
# state is only exposed through the Firebase App Check Management REST API
# (firebaseappcheck.googleapis.com/v1), so this script calls that directly
# with a token from `gcloud auth print-access-token` (the credentials file
# created by google-github-actions/auth@v2 upstream in deploy.yml is picked
# up automatically via CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).
#
# Firestore and Cloud Storage are project-level "services" in that API and
# can be checked remotely (GET .../v1/projects/{id}/services, response
# field "services[].enforcementMode" — confirmed against the API's
# discovery document). Cloud Functions is NOT one of the API's supported
# services (only firestore.googleapis.com, firebasestorage.googleapis.com,
# firebasedatabase.googleapis.com, identitytoolkit.googleapis.com are) —
# App Check for callables is enforced per-function in code via the
# `enforceAppCheck` option, centralized in functions/src/lib/callable.ts's
# defineCallable() wrapper (defaults to true). That default line is
# grep-matched below; keep the two files in sync (see the comment above
# the line in callable.ts).
#
# Usage: ./scripts/check-appcheck.sh <project-id> <alias>
#   <alias> must be "prod" or "dev" (whatever deploy.yml resolved the
#   workflow_dispatch `target` input to). Strict mode (fail the job, exit 1
#   on any non-ENFORCED check, or on an auth/transport failure reaching the
#   App Check API) is used only when <alias> is exactly "prod". Any other
#   alias (e.g. "dev") only warns and exits 0, including on auth/transport
#   failure — non-prod deploys must not be blocked by a flaky check.

set -uo pipefail
# Not `-e`: every risky external call below (gcloud, curl) is guarded
# explicitly so we can distinguish "could not verify" from "verified and
# not enforced" and choose fail-vs-warn ourselves, rather than the shell
# exiting out from under that distinction.

P="${1:?usage: check-appcheck.sh <project-id> <alias>}"
ALIAS="${2:?usage: check-appcheck.sh <project-id> <alias> (alias must be 'prod' or 'dev')}"

STRICT=false
if [[ "$ALIAS" == "prod" ]]; then
  STRICT=true
fi

FAILED=false

# Not-enforced failures (we successfully read the API / code, and it says
# enforcement is off) — collected and reported at the end.
report() {
  local msg="$1"
  if [[ "$STRICT" == "true" ]]; then
    echo "APP CHECK GATE: FAIL — ${msg}" >&2
    FAILED=true
  else
    echo "APP CHECK GATE: warn (non-prod, non-blocking) — ${msg}" >&2
  fi
}

# Auth/transport failures (we could NOT reach or parse the API) — a
# distinct failure mode from "not enforced": exits immediately, since
# there is nothing further we can reliably check.
transport_fail() {
  local msg="App Check status could not be verified (auth/API error): $1"
  if [[ "$STRICT" == "true" ]]; then
    echo "APP CHECK GATE: FAIL — ${msg}" >&2
    exit 1
  else
    echo "APP CHECK GATE: warn (non-prod, non-blocking) — ${msg}" >&2
    exit 0
  fi
}

echo "App Check status for project: ${P} (alias=${ALIAS}, strict=${STRICT})"

TOKEN="$(gcloud auth print-access-token 2>&1)"
GCLOUD_EXIT=$?
if [[ $GCLOUD_EXIT -ne 0 ]]; then
  transport_fail "gcloud auth print-access-token failed (exit ${GCLOUD_EXIT}): ${TOKEN}"
fi

BODY_FILE="$(mktemp)"
ERR_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE" "$ERR_FILE"' EXIT

HTTP_CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://firebaseappcheck.googleapis.com/v1/projects/${P}/services" \
  2>"$ERR_FILE")"
CURL_EXIT=$?
CURL_ERR="$(cat "$ERR_FILE" 2>/dev/null || true)"

if [[ $CURL_EXIT -ne 0 ]]; then
  transport_fail "curl failed (exit ${CURL_EXIT}) reaching the App Check API: ${CURL_ERR:-no error output}"
fi

RESPONSE="$(cat "$BODY_FILE" 2>/dev/null || true)"

if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
  ERR_KIND="$(jq -r '.error.status // .error.message // empty' <<<"$RESPONSE" 2>/dev/null || true)"
  [[ -n "$ERR_KIND" ]] || ERR_KIND="${RESPONSE:-empty response body}"
  transport_fail "App Check API returned HTTP ${HTTP_CODE:-000}: ${ERR_KIND}"
fi

# 200 OK is not proof of a usable body: never let an unparseable body or a
# 200-with-error-payload silently read as an empty/MISSING service list.
if ! jq -e . >/dev/null 2>&1 <<<"$RESPONSE"; then
  transport_fail "App Check API returned HTTP 200 with a non-JSON body"
fi
if jq -e '.error' >/dev/null 2>&1 <<<"$RESPONSE"; then
  ERR_KIND="$(jq -r '.error.status // .error.message // "unknown error"' <<<"$RESPONSE")"
  transport_fail "App Check API returned HTTP 200 with an error payload: ${ERR_KIND}"
fi

check_service() {
  local service_id="$1" label="$2"
  local mode
  mode="$(jq -r --arg svc "$service_id" \
    '(.services // []) | map(select(.name | endswith("/services/" + $svc))) | (.[0].enforcementMode // "MISSING")' \
    <<<"$RESPONSE")"
  echo "  ${label} (${service_id}): ${mode}"
  [[ "$mode" == "ENFORCED" ]] || report "${label} enforcementMode is '${mode}', expected ENFORCED"
}

check_service "firestore.googleapis.com" "Firestore"
check_service "firebasestorage.googleapis.com" "Storage"

# Cloud Functions callables have no project-level "service" in the App
# Check Management API; verify the code-level enforceAppCheck default.
CALLABLE_FILE="functions/src/lib/callable.ts"
if [[ -f "$CALLABLE_FILE" ]] && grep -q "enforceAppCheck: opts.enforceAppCheck ?? true" "$CALLABLE_FILE"; then
  echo "  Functions (${CALLABLE_FILE}): enforceAppCheck defaults to true"
else
  report "Functions callable wrapper (${CALLABLE_FILE}) no longer defaults enforceAppCheck to true"
fi

if [[ "$FAILED" == "true" ]]; then
  echo "App Check enforcement gate FAILED for ${P}" >&2
  exit 1
fi

echo "App Check enforcement gate passed for ${P}"
