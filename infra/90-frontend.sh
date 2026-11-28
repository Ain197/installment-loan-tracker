#!/usr/bin/env bash
# Puts the website on S3 with the API Gateway address in js/config.js.
source "$(dirname "$0")/config.sh"

say "Frontend: API address in js/config.js"
URL="$(api_url)"
STAGE="$TMP_DIR/frontend"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$ROOT_DIR/frontend/." "$STAGE/"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const text = fs.readFileSync(file, "utf8").replace(/const FLOCI_API = .*;/, `const FLOCI_API = "${process.argv[2]}";`);
  fs.writeFileSync(file, text);
' "$STAGE/js/config.js" "$URL"
ok "FLOCI_API = $URL"

say "Frontend: upload to s3://$WEB_BUCKET (with the right content types)"
awsl s3 sync "$STAGE" "s3://$WEB_BUCKET" --delete --exclude "*" --include "*.html" --content-type "text/html; charset=utf-8" >/dev/null
awsl s3 sync "$STAGE/css" "s3://$WEB_BUCKET/css" --delete --content-type "text/css; charset=utf-8" >/dev/null
awsl s3 sync "$STAGE/js" "s3://$WEB_BUCKET/js" --delete --content-type "text/javascript; charset=utf-8" >/dev/null
awsl s3 ls "s3://$WEB_BUCKET" --recursive | awk '{print "   " $4}'

echo
ok "Open the app: $WEBSITE_ORIGIN/$WEB_BUCKET/index.html   (type localhost, not 127.0.0.1)"
