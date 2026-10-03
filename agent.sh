#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node src/launcher.js "$@"
