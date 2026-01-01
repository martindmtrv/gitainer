#!/bin/sh
set -e

# Start dockerd in the background
dockerd-entrypoint.sh &

# Wait for dockerd to be ready
echo "Waiting for Docker daemon to start..."
timeout=30
while ! docker info >/dev/null 2>&1; do
    timeout=$((timeout - 1))
    if [ $timeout -le 0 ]; then
        echo "Timed out waiting for Docker daemon"
        exit 1
    fi
    sleep 1
done
echo "Docker daemon started!"

# Execute the test command
exec "$@"
