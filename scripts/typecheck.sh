#!/usr/bin/env sh
set -eu

docker-compose run --rm --no-deps worker sh -lc "corepack enable && pnpm typecheck"
