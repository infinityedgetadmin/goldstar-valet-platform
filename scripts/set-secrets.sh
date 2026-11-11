#!/usr/bin/env bash
# scripts/set-secrets.sh — run once per project by an owner; never commit values
# usage: ./scripts/set-secrets.sh dev
set -euo pipefail
P="$1"
for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN MAPBOX_SERVER_TOKEN PLATE_RECOGNIZER_TOKEN; do
  echo "Setting $s on $P"; npx firebase-tools functions:secrets:set "$s" --project "$P"
done
