#!/bin/sh
set -e

# Start dockerd in the background
# Docker 29 defaults to the containerd image store, which (unlike the classic storage drivers)
# doesn't fall back to vfs when overlay can't be nested, e.g. when the tests themselves run
# inside a container.
dockerd-entrypoint.sh --feature containerd-snapshotter=false &

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
