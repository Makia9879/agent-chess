#!/usr/bin/env sh
set -eu

docker-compose run --rm --no-deps worker sh -lc "pnpm install"
docker-compose up -d postgres
docker-compose run --rm migrate
docker-compose up -d worker web
