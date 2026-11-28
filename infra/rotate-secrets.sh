#!/usr/bin/env bash
# Rotates the app secret in Secrets Manager: new JWT_SECRET and INTERNAL_TOKEN, keeping the old
# values as *_PREVIOUS so logged-in users and services keep working while their cache refreshes
# (SECRETS_TTL_SECONDS, 5 minutes). No redeploy needed. Run it again later to drop the old values.
source "$(dirname "$0")/config.sh"
say "Rotating $SECRET_APP"
awsl secretsmanager get-secret-value --secret-id "$SECRET_APP" --query SecretString --output text > "$TMP_DIR/rot-old.json"
node -e '
  const fs = require("fs");
  const old = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const r = () => require("crypto").randomBytes(32).toString("hex");
  const next = { JWT_SECRET: r(), INTERNAL_TOKEN: r(), JWT_SECRET_PREVIOUS: old.JWT_SECRET, INTERNAL_TOKEN_PREVIOUS: old.INTERNAL_TOKEN };
  fs.writeFileSync(process.argv[2], JSON.stringify(next));
' "$TMP_DIR/rot-old.json" "$TMP_DIR/rot-new.json"
awsl secretsmanager put-secret-value --secret-id "$SECRET_APP" --secret-string "file://$TMP_DIR/rot-new.json" >/dev/null
rm -f "$TMP_DIR"/rot-*.json
ok "new version stored; old values kept as *_PREVIOUS"
awsl secretsmanager list-secret-version-ids --secret-id "$SECRET_APP" --query 'Versions[].[VersionId,join(`,`,VersionStages)]' --output text | sed 's/^/   /'
echo "   Lambdas pick up the new values within ${SECRETS_TTL_SECONDS:-300} seconds."
