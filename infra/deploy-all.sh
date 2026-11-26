#!/usr/bin/env bash
# Builds and deploys the whole app on Floci in the right order. Safe to run again after a change
# (or after Floci restarts and loses its resources).
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Building Lambda zips ..."
( cd services && npm install --no-audit --no-fund >/dev/null )
node infra/build-zips.js
bash infra/00-shared.sh
bash infra/05-secrets.sh
bash infra/10-auth.sh
bash infra/20-plans.sh
bash infra/30-payments.sh
bash infra/40-reminders.sh
bash infra/90-frontend.sh
bash infra/check.sh
