#!/bin/sh
set -e

docker-compose -f /self-update.yaml -p "$STACK_NAME" up -d --force-recreate
