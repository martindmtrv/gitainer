#!/usr/bin/env bash
# Sets up and tears down a demo gitainer for trying out the manager UI: the server from this
# checkout, with a handful of throwaway stacks (see ../demo) deployed on the local docker.
#
#   scripts/demo.sh up [--tunnel]   set the demo up from scratch, replacing a previous one
#   scripts/demo.sh down            stop it and remove everything it created
#
# --tunnel also shares the UI through localtunnel (`lt`), as a public URL protected by the API key.
#
# Environment:
#   GITAINER_DEMO_DIR        where the demo keeps its repo, data and logs (default: $TMPDIR/gitainer-demo)
#   GITAINER_API_KEY         the API key to use (default: demo)
#   GITAINER_DEMO_SUBDOMAIN  the localtunnel subdomain for --tunnel (default: gitainer-demo)
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${GITAINER_DEMO_DIR:-${TMPDIR:-/tmp}/gitainer-demo}"
# marks DEMO_DIR as created by this script, so `down` never removes any other directory
MARKER="$DEMO_DIR/.gitainer-demo"
# the compose projects of the stacks in ../demo: `down` only removes containers of these
STACKS=(demo-cache demo-db demo-gitainer demo-legacy demo-metrics demo-nas-media demo-web)
SELF_STACK=demo-gitainer
# server.ts listens on these
GIT_PORT=3000
UI_PORT=8080

fail() {
  echo "demo: $*" >&2
  exit 1
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# waits up to $2 seconds (default 30) for the command in $1 to succeed
wait_for() {
  local attempts=$(( ${2:-30} * 2 ))
  until eval "$1"; do
    attempts=$((attempts - 1))
    [ "$attempts" -gt 0 ] || return 1
    sleep 0.5
  done
}

stop_pid_file() {
  local pid_file="$DEMO_DIR/$1.pid"
  if [ -f "$pid_file" ]; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    rm -f "$pid_file"
  fi
}

# Starts the server with a clean environment, so the Env page shows the demo's variables and
# nothing from the shell this runs in. Arguments are extra VAR=value pairs, overriding the ones here.
start_server() {
  (
    cd "$PACKAGE_DIR"
    exec nohup env -i PATH="$PATH" HOME="$DEMO_DIR/home" \
      GIT_ROOT="$DEMO_DIR/repo" GITAINER_DATA="$DEMO_DIR/data" STACKS_PATH="$DEMO_DIR/stacks" \
      FRAGMENTS_PATH=fragments REPO_NAME=docker GIT_BRANCH=main \
      GITAINER_SELF_STACK="$SELF_STACK" GITAINER_API_KEY="$API_KEY" STACK_UPDATE_ON_ENV_CHANGE=1 \
      DOMAIN=demo.example.test CACHE_PASSWORD=demo-not-a-real-secret DB_PASSWORD=demo-db-password \
      DISABLE_LEGACY=true TZ=Europe/Sofia \
      "$@" \
      bun run src/server/server.ts
  ) >> "$DEMO_DIR/server.log" 2>&1 &
  echo $! > "$DEMO_DIR/server.pid"

  wait_for "port_in_use $GIT_PORT && port_in_use $UI_PORT" \
    || fail "the server didn't start, see $DEMO_DIR/server.log"
}

stop_server() {
  stop_pid_file server
  wait_for "! port_in_use $GIT_PORT && ! port_in_use $UI_PORT" 10 \
    || fail "the server didn't stop"
}

demo_git() {
  HOME="$DEMO_DIR/home" git -C "$DEMO_DIR/client" "$@"
}

commit() {
  demo_git add -A
  demo_git commit -q -m "$1"
}

# pushes through gitainer, which deploys the change before the push returns. A push is rejected
# while the previous synthesis is still finishing, so it's retried
push() {
  wait_for "demo_git push -q origin main >> '$DEMO_DIR/push.log' 2>&1" 30 \
    || fail "the push was rejected, see $DEMO_DIR/push.log"
}

down() {
  if [ -e "$DEMO_DIR" ] && [ ! -e "$MARKER" ]; then
    fail "$DEMO_DIR wasn't created by this script, not touching it"
  fi

  stop_pid_file tunnel
  stop_pid_file server

  if docker info > /dev/null 2>&1; then
    local stack containers
    for stack in "${STACKS[@]}"; do
      containers="$(docker ps -aq --filter "label=com.docker.compose.project=$stack")"
      if [ -n "$containers" ]; then
        # shellcheck disable=SC2086
        docker rm -f $containers > /dev/null
      fi
      docker network rm "${stack}_default" > /dev/null 2>&1 || true
    done
    docker rm -f "gitainer-self-update-$SELF_STACK" > /dev/null 2>&1 || true
  fi

  rm -rf "$DEMO_DIR"
}

up() {
  local tunnel=false
  [ "${1:-}" = "--tunnel" ] && tunnel=true

  command -v bun > /dev/null || fail "bun is not installed"
  docker info > /dev/null 2>&1 || fail "docker isn't running"
  if $tunnel; then
    command -v lt > /dev/null || fail "--tunnel needs localtunnel (lt)"
  fi

  down
  port_in_use "$GIT_PORT" && fail "port $GIT_PORT is in use"
  port_in_use "$UI_PORT" && fail "port $UI_PORT is in use"

  # short on purpose: it only guards made-up stacks and variables. Set a real one for a tunnel
  # that stays open
  API_KEY="${GITAINER_API_KEY:-demo}"
  mkdir -p "$DEMO_DIR/repo" "$DEMO_DIR/data" "$DEMO_DIR/home"
  touch "$MARKER"
  HOME="$DEMO_DIR/home" git config --global user.name demo
  HOME="$DEMO_DIR/home" git config --global user.email demo@example.test

  echo "demo: starting gitainer"
  start_server

  echo "demo: pushing the demo stacks"
  HOME="$DEMO_DIR/home" git clone -q "http://localhost:$GIT_PORT/docker.git" "$DEMO_DIR/client"
  cp -R "$PACKAGE_DIR/demo/repo/." "$DEMO_DIR/client/"
  commit "demo stacks"
  push

  # a push that fails and is rolled back, so the history has a failure in it
  sed -i.bak 's|image: alpine:latest|image: registry.invalid/nope:1|' "$DEMO_DIR/client/stacks/demo-db/docker-compose.yaml"
  rm "$DEMO_DIR/client/stacks/demo-db/docker-compose.yaml.bak"
  commit "demo-db: an image that doesn't exist"
  push
  demo_git fetch -q
  demo_git reset -q --hard origin/main

  # The remaining stacks are committed behind gitainer's back, with the server stopped: one is on
  # a host that doesn't answer, so a real push of it would fail and be rolled back. The server
  # then comes back with a different CACHE_PASSWORD and env updates off, which leaves the stacks
  # reading it with a stale env.
  wait_for "[ -z \"\$(docker ps -aq --filter name=gitainer-self-update-$SELF_STACK)\" ]" 30 || true
  stop_server
  cp -R "$PACKAGE_DIR/demo/undeployed/." "$DEMO_DIR/client/"
  commit "a remote stack and one that isn't deployed"
  demo_git push -q "$DEMO_DIR/repo/docker.git" main >> "$DEMO_DIR/push.log" 2>&1
  start_server STACK_UPDATE_ON_ENV_CHANGE=0 CACHE_PASSWORD=rotated-demo-value

  local url="http://localhost:$UI_PORT"
  if $tunnel; then
    echo "demo: opening the tunnel"
    nohup lt --port "$UI_PORT" --subdomain "${GITAINER_DEMO_SUBDOMAIN:-gitainer-demo}" > "$DEMO_DIR/tunnel.log" 2>&1 &
    echo $! > "$DEMO_DIR/tunnel.pid"
    wait_for "grep -q 'your url is' '$DEMO_DIR/tunnel.log'" 20 || fail "the tunnel didn't open, see $DEMO_DIR/tunnel.log"
    url="$(sed -n 's/^your url is: //p' "$DEMO_DIR/tunnel.log")"
  fi

  echo
  echo "Gitainer demo is up"
  echo "  UI:      $url"
  echo "  API key: $API_KEY"
  echo "  git:     http://localhost:$GIT_PORT/docker.git"
  echo "  files:   $DEMO_DIR (server.log, push.log)"
  echo "Remove it with: bun run demo:cleanup"
}

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down; echo "demo: removed" ;;
  *) fail "usage: demo.sh up [--tunnel] | down" ;;
esac
