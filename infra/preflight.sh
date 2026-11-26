#!/usr/bin/env bash
# Checks the tools the deploy needs, starts Floci if it is not running, and logs what it finds.
export MSYS_NO_PATHCONV=1
echo "== Preflight $(date)"
echo "folder: $(pwd)"
for t in node npm aws docker curl; do
  if command -v "$t" >/dev/null 2>&1; then echo "  ok   $t: $($t --version 2>&1 | grep -v WARNING | head -1)"; else echo "  MISSING $t"; fi
done

floci_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4566/_floci/health 2>/dev/null)" != "000" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4566/ 2>/dev/null)" != "000" ]; }

echo "  waiting for Docker Desktop ..."
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 3; done
docker info >/dev/null 2>&1 && echo "  ok   Docker engine is running" || { echo "  ERROR Docker engine is not running (start Docker Desktop)"; exit 1; }

echo "  all containers:"; docker ps -a --format '    {{.Names}}  {{.Image}}  {{.Status}}' | head -20

if floci_up; then
  echo "  ok   Floci already answers on localhost:4566"
else
  existing="$(docker ps -a --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /floci/ {print $1; exit}')"
  if [ -n "$existing" ]; then
    echo "  starting existing Floci container: $existing"
    docker start "$existing"
  else
    echo "  no Floci container found: creating one (floci/floci:latest)"
    docker run -d --name floci -p 4566:4566 -v //var/run/docker.sock:/var/run/docker.sock -u root \
      -e FLOCI_STORAGE_MODE=hybrid floci/floci:latest
  fi
  for i in $(seq 1 40); do floci_up && break; sleep 3; done
  floci_up && echo "  ok   Floci answers on localhost:4566" || { echo "  ERROR Floci did not start; logs:"; docker logs --tail 40 "${existing:-floci}" 2>&1; exit 1; }
fi
# Lambda functions run in this image; Floci gives a download only 5 minutes, so fetch it here first
if docker image inspect public.ecr.aws/lambda/nodejs:24 >/dev/null 2>&1; then
  echo "  ok   Lambda image public.ecr.aws/lambda/nodejs:24 is downloaded"
else
  echo "  downloading the Lambda image public.ecr.aws/lambda/nodejs:24 (first time only, a few minutes) ..."
  docker pull public.ecr.aws/lambda/nodejs:24 2>&1 | grep -vE "Waiting|Downloading|Extracting|Verifying"
fi
[ -f infra/deploy.env ] && echo "  deploy.env: present" || echo "  deploy.env: MISSING"
