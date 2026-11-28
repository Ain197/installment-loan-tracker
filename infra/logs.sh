#!/usr/bin/env bash
# Shows the CloudWatch logs of one service: bash infra/logs.sh plans|payments|reminders|auth [minutes]
source "$(dirname "$0")/config.sh"
awsl logs tail "/aws/lambda/$PREFIX-${1:-plans}" --since "${2:-30}m" --format short
