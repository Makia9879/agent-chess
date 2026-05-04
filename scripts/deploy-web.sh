#!/usr/bin/env sh
set -eu

docker-compose run --rm --no-deps web sh -lc "pnpm --dir apps/web deploy"
