#!/usr/bin/env sh
set -eu

if [ "${CONFIRM_NEON_MIGRATION:-}" != "yes" ]; then
  echo "Refusing to migrate Neon without CONFIRM_NEON_MIGRATION=yes" >&2
  exit 1
fi

if [ -z "${NEON_DATABASE_URL:-}" ]; then
  echo "NEON_DATABASE_URL is required" >&2
  exit 1
fi

docker-compose run --rm -e DATABASE_URL="$NEON_DATABASE_URL" migrate
