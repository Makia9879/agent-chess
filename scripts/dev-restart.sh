#!/usr/bin/env sh
set -eu

docker-compose restart worker web mcp-adapter
