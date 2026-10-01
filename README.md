# Gitainer

Simple Git-based container management platform for Docker Standalone

## Features

- All the benefits of Git such as versioning, portability, etc.
- Pass through Variables and YAML fragments to keep your stacks DRY
- Prepend setup commands to containers via `prefix_entrypoint` without overriding original execution
- Run a stack-level `x-shutdown-hook` (e.g. a backup) before a stack is taken down
- Keep a stack down without deleting it via `x-gitainer-disabled: true`, or from an env var
- Comment-only changes to a compose file or fragment don't redeploy the stack
- Lightweight HTTP API to trigger stack actions from CI/CD pipelines
- Small [manager UI](#manager-ui) to see stacks, run stack actions and inspect the env
- POST webhook option for update responses

## Usage

### Quick Start

Deploy the stack with docker compose
```
services:
  gitainer:
    image: ghcr.io/martindmtrv/gitainer
    volumes:
      - ./resources/bare:/var/gitainer/repo      
      - ./resources/data:/var/gitainer/data
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - 3000:3000 # git server
      - 8080:8080 # webui and webhooks
    environment:
      # GITAINER_API_KEY: <optional API key to secure webhooks>
      # STACK_UPDATE_ON_ENV_CHANGE: 1 # 1/true/yes/on enables, anything else (incl. 0) disables
      # POST_WEBHOOK: <some POST endpoint>
      # GITAINER_SELF_STACK: <name of the stack that is gitainer's own deployment, see Self-Updating Gitainer>
      # GITAINER_CLONE_URL: <git clone URL shown in the UI, defaults to http://<host>:3000/<REPO_NAME>.git>
      # GITAINER_SELF_UPDATE_HELPER_IMAGE: <defaults to the docker image gitainer is built on>
      # defaults
      # GIT_ROOT: /var/gitainer/repo
      # GITAINER_DATA: /var/gitainer/data
      # REPO_NAME: docker
      # GIT_BRANCH: main
      # FRAGMENTS_PATH=fragments
```

On the machine you want to manage stacks from clone the repo
```
git clone <hostmachine>:3000/docker.git
cd docker
```

Create your stack
```
mkdir -p stacks/mystack
vi stacks/mystack/docker-compose.yaml
```

Push the changes
```
git add .
git commit -m "my first stack"
git push
```

"mystack" will now be deployed on the host machine

### POST Webhook

If `POST_WEBHOOK` is set, Gitainer will send an HTTP POST with a `Content-Type: application/json` header to that URL after a stack update completes. The body is the plain JSON result object itself (not a string-wrapped copy) — parse it directly as JSON.

Every payload includes a `title` field so you can tell which trigger fired it: `"Gitainer: Git Push"`, `"Gitainer: Env Update"`, `"Gitainer: Webhook"`, or `"Gitainer: UI"` for a stack action started from the [manager UI](#manager-ui). The `msg`/`err` field is a self-contained status string that names the affected stack(s), so you don't need to also inspect `changes`/`stackName`/`output` just to know what happened — handy if you're feeding this straight into a notifier.

There are two triggers for this webhook, each with a slightly different payload shape:

**Push-triggered synthesis** (a `git push` deploying one or more stacks — `title: "Gitainer: Git Push"` — or a resynthesis triggered by `STACK_UPDATE_ON_ENV_CHANGE` — `title: "Gitainer: Env Update"`) fires the webhook on both success and failure:
```json
{
  "title": "Gitainer: Git Push",
  "msg": "Synthesis succeeded for 1 stack(s): stacks/mystack/docker-compose.yaml",
  "changes": [
    { "file": "stacks/mystack/docker-compose.yaml", "type": "M", "reason": "..." }
  ]
}
```

A stack pulled in only by a changed env var or fragment is skipped if it isn't deployed (see [Skipping stacks that aren't deployed](#skipping-stacks-that-arent-deployed)). The skipped stacks are listed in `skippedStacks`, and appended to `msg` (or `err`):
```json
{
  "title": "Gitainer: Env Update",
  "msg": "Synthesis succeeded for 1 stack(s): stacks/mystack/docker-compose.yaml. Skipped 1 stack(s) that aren't deployed: downedstack",
  "changes": [
    { "file": "stacks/mystack/docker-compose.yaml", "type": "M", "reason": "Stack contains references to MY_VAR", "indirect": true }
  ],
  "skippedStacks": ["downedstack"]
}
```

A stack whose compose file or fragments only changed in comments isn't redeployed (see [Comment-only changes](#comment-only-changes)). These stacks are listed in `commentOnlyStacks`, left out of `changes`, and appended to `msg` (or `err`):
```json
{
  "title": "Gitainer: Git Push",
  "msg": "Synthesis succeeded for 0 stack(s). Skipped 1 stack(s) with comment-only changes: mystack",
  "changes": [],
  "commentOnlyStacks": ["mystack"]
}
```

Stacks kept down by [`x-gitainer-disabled: true`](#disabling-a-stack) are listed in `disabledStacks`, and appended to `msg` as `Disabled with x-gitainer-disabled (not deployed): <names>`.

On failure from a `git push` (where the bad commit is rolled back), the payload also reports what was rolled back:
```json
{
  "title": "Gitainer: Git Push",
  "err": "Got an error during synthesis of stack \"stacks/mystack/docker-compose.yaml\", removing the bad commit. Succeeded stacks (not rolled back): stacks/other/docker-compose.yaml. Error: ...",
  "output": "...",
  "failedStackContent": "...",
  "suceededStacks": ["stacks/other/docker-compose.yaml"],
  "failedStack": "stacks/mystack/docker-compose.yaml",
  "latestCommit": {
    "hash": "abc1234...",
    "date": "2026-07-18 07:30:00 +0000",
    "message": "my first stack",
    "refs": "HEAD -> main",
    "body": "",
    "author_name": "...",
    "author_email": "..."
  }
}
```

On failure from an env-change-triggered resynthesis (no commit to roll back), the payload is just:
```json
{
  "title": "Gitainer: Env Update",
  "err": "Got an error during synthesis of stack \"stacks/mystack/docker-compose.yaml\": ...",
  "output": "...",
  "failedStackContent": "..."
}
```

**API-triggered update** (`POST /api/stacks/:stackName`, `title: "Gitainer: Webhook"`) only fires the webhook on success — a failed update responds to the caller with a 400 and `{ "err": "..." }`, but does not notify `POST_WEBHOOK`. An update still running after 30 seconds (e.g. a slow image pull) responds with a 200 straight away and streams a newline every 30 seconds until it finishes, so the connection isn't dropped as idle, then the JSON result; a failure then only shows up in its `err` field. The leading newlines are valid JSON whitespace, so `jq` and `JSON.parse` read the body as usual:
```json
{
  "title": "Gitainer: Webhook",
  "stackName": "mystack",
  "msg": "Successfully updated stack mystack: ...",
  "output": "..."
}
```

**Stack down / up / restart** (`POST /api/stacks/:stackName/down`, `/up`, `/restart`, `title: "Gitainer: Webhook"`) act on a stack from the repo without pulling its images:

- `down` runs the stack's [`x-shutdown-hook`](#shutdown-hook), then `docker compose down`. The stack stays in the repo: env and fragment changes [skip it](#skipping-stacks-that-arent-deployed) while it's down, but a push that changes its compose file (beyond [comments](#comment-only-changes)), `up`, `restart` or `POST /api/stacks/:stackName` brings it back up. To keep a stack down durably, [disable it](#disabling-a-stack) in git; to remove it for good, delete it.
- `up` runs `docker compose up -d` with no down or pull first. It starts a downed stack, and only recreates containers whose config or env changed. Images that aren't present locally are still pulled.
- `restart` is a forced reload without the pull: the shutdown hook, a down, then `up -d --force-recreate`.

They respond, stream keepalives and notify `POST_WEBHOOK` like the API-triggered update above, with `msg` reading `Successfully downed/started/restarted stack <name>: ...`. An unknown stack responds with a 404. The [self-stack](#self-updating-gitainer) is refused with a 400, since downing it would kill Gitainer itself; update it with `POST /api/stacks/:stackName` instead. A [disabled](#disabling-a-stack) stack can be downed, but `up`, `restart` and `POST /api/stacks/:stackName` refuse it with a 400.

Only one of these actions (the update included) runs on a stack at a time: a second one on the same stack while the first is still running is refused with a 409.

**Bulk stop/start by label** (`POST /api/labels/:identifier/stop`, `POST /api/labels/:identifier/start`, `title: "Gitainer: Webhook"`) stops or starts every container labelled `gitainer.identifier=<identifier>`, regardless of which stack it belongs to. Only fires the webhook on success — a docker error responds to the caller with a 400 and `{ "err": "..." }`, but does not notify `POST_WEBHOOK`:
```json
{
  "title": "Gitainer: Webhook",
  "identifier": "myapp",
  "msg": "Stopped 2 container(s) labelled gitainer.identifier=myapp",
  "containerIds": ["abc123...", "def456..."]
}
```

To make containers eligible, label them in the compose file:
```yaml
services:
  app:
    labels:
      gitainer.identifier: myapp
```

**Registry cleanup** (`POST /api/registry/:containerName/cleanup`, `title: "Gitainer: Webhook"`) runs `registry garbage-collect` inside a running Docker Registry ([distribution/distribution](https://hub.docker.com/_/registry)) container via `docker exec`, reclaiming blob storage from deleted/untagged manifests. Only fires the webhook on success — a docker error responds to the caller with a 400 and `{ "err": "..." }`, but does not notify `POST_WEBHOOK`:
```json
{
  "title": "Gitainer: Webhook",
  "containerName": "registry",
  "msg": "Ran registry garbage-collect on registry",
  "output": "..."
}
```
Query params: `?deleteUntagged=true` adds registry's `-m` flag (also delete manifests with no tags); `?configPath=...` overrides the config file path inside the container (default `/etc/docker/registry/config.yml`).

**Named commands** (`POST /api/commands/:name`, `title: "Gitainer: Webhook"`) run an operator-defined `docker exec ...` command via `GITAINER_COMMANDS`, a JSON object mapping a name to a command string. Only `docker exec` commands are accepted (not arbitrary shell) - Gitainer validates every command at startup and refuses to start if one doesn't start with `docker exec`. Unknown name returns a 404. Only fires the webhook on success - a docker error responds to the caller with a 400 and `{ "err": "..." }`, but does not notify `POST_WEBHOOK`:
```json
{
  "title": "Gitainer: Webhook",
  "name": "registry-gc",
  "msg": "Ran command \"registry-gc\"",
  "output": "..."
}
```
```
GITAINER_COMMANDS={"registry-gc":"docker exec registry registry garbage-collect /etc/docker/registry/config.yml"}
```
The built-in `/api/registry/:containerName/cleanup` endpoint above covers the common registry-cleanup case with a typed response; `GITAINER_COMMANDS` is the escape hatch for anything else you want exposed as an API call.

#### Example: forwarding to Apprise

[Apprise API](https://github.com/caronc/apprise-api) is a self-hosted REST front-end for [Apprise](https://github.com/caronc/apprise) that fans a single webhook out to Discord, Telegram, ntfy, Slack, and dozens of other notification services. Point `POST_WEBHOOK` at its `/notify/<tag>` endpoint and remap Gitainer's `msg`/`err` fields onto Apprise's `body` field:

```
POST_WEBHOOK=https://apprise.example.com/notify/gitainer?:msg=body&:err=body
```

`title` doesn't need remapping — Apprise API already reads a top-level `title` key by default, and Gitainer's payload already has one, so `Gitainer: Git Push` / `Gitainer: Env Update` / `Gitainer: Webhook` / `Gitainer: UI` shows up as the notification title automatically.

In docker-compose, quote the value since it contains `?`, `&`, and `:`:
```yaml
environment:
  POST_WEBHOOK: "https://apprise.example.com/notify/gitainer?:msg=body&:err=body"
```

### Manager UI

Gitainer serves a small UI on port 8080 (`http://<host>:8080/`) to operate the stacks in the repo. Editing them still happens in git. Its pages have their own addresses (`/stacks/mystack`, `/env`, ...), so behind a reverse proxy it has to be served at the root of its hostname, not under a sub-path.

- **Stacks** shows the repo's git clone URL with a copy button, and lists every stack with its container states, and badges for a [stale env](#stale-env), the [self-stack](#self-updating-gitainer), [disabled](#disabling-a-stack) stacks and [remote hosts](#remote-docker-host). The buttons call the update / restart / up / down endpoints above, with the same guards: the self-stack can only be updated, a disabled stack only downed.
- **A stack's page** shows its containers, its compose file with fragments expanded, the variables it reads (with the unset ones flagged) and its recent deploys with their output. The compose file is shown without env values by default; "With envs" shows it interpolated.
- **Env** lists the keys of Gitainer's environment: whether each comes from [Infisical](#infisical-secrets) or the container, and which stacks read it, marking the ones with a [stale](#stale-env) value of it. Values are masked and revealed one key at a time. Variables that stacks read but that aren't set are listed separately.
- **Info** lists Gitainer's own settings (the env vars it reads) with a short description of each and its current value. Values that can hold credentials aren't shown there: `POST_WEBHOOK`, `GITAINER_COMMANDS` and `INFISICAL_CLIENT_ID` link to the Env page to be revealed, and the API key and Infisical client secret are never shown.
- **History** lists what Gitainer did, newest first: every push, env update and API call, with the deploys each one made and its full result.

The clone URL defaults to `http://<the host the UI is opened at>:3000/<REPO_NAME>.git`. Set `GITAINER_CLONE_URL` if the git server is reached differently, e.g. through a reverse proxy or on another host port.

If `GITAINER_API_KEY` is set, the UI asks for it once and keeps it for the browser tab (in `sessionStorage`). Without an API key the UI works, but shows no env values: an open API would otherwise hand every secret to anyone who can reach port 8080.

The UI is static files calling these endpoints, which are also usable on their own:

| Endpoint | Returns |
| --- | --- |
| `GET /api/info` | `repoName`, `branch`, and `cloneUrl` if `GITAINER_CLONE_URL` is set. |
| `GET /api/settings` | Gitainer's own settings: `key`, `group`, `description`, `default` (what the image sets), `set`, `visibility` (`plain`, `reveal` or `hidden`), the `value` of the `plain` ones, and `enabled` for on/off settings. |
| `GET /api/stacks` | Every stack: `name`, `self`, `disabled`, `remoteHost`, its `containers` (`name`, `service`, `state`, `status`), the action in flight (`busy`) and `staleEnv`, the variables it was deployed with another value of. A docker host that doesn't answer within 8 seconds leaves `containers` out and sets `statusErr`. `?status=local` skips the remote hosts. |
| `GET /api/stacks/:stackName/status` | The same, for one stack. |
| `GET /api/stacks/:stackName` | The compose file with fragments expanded and `${VARS}` left as they are. |
| `GET /api/stacks/:stackName/resolved` | The compose file with env values interpolated, from `docker compose config`: what would deploy now, which isn't necessarily what is running. Compose normalises it, so comments are dropped. 403 unless an API key is configured. |
| `GET /api/stacks/:stackName/variables` | The variables the stack reads: `name`, `set`, `hasDefault`, `required`. No values. |
| `GET /api/env` | `env`: every key with its `source` (`infisical` or `container`), the `stacks` reading it, and the `staleStacks` deployed with another value of it. `unset`: variables stacks read that aren't set. No values. |
| `GET /api/env/:key` | One value. 403 unless an API key is configured, and always for `GITAINER_API_KEY`, `WEBHOOK_API_KEY` and `INFISICAL_CLIENT_SECRET`. |
| `GET /api/events` | The stored [history](#history), newest first: `type` (`Git Push`, `Env Update`, `Webhook` or `UI`), `ok`, `message`, `createdAt`, the `payload` and its `deploys`. `?limit=` defaults to 50, up to 500. |
| `GET /api/deploys` | The stored deploys, newest first: `stack`, `action`, `ok`, `output`, `trigger`, `commit`, `startedAt`, `finishedAt`. `?stack=` narrows it to one stack, `?limit=` as above. |

#### Stale env

A running stack has a stale env when a variable it reads has changed since the stack was last deployed: it's still running with the old value. With `STACK_UPDATE_ON_ENV_CHANGE` on, Gitainer redeploys such a stack by itself, so this mostly shows when that's off or the redeploy failed. The stack gets a "stale env" badge naming the variables, and updating, restarting or upping it applies the current values and clears it.

Gitainer knows this from a hash of each variable's value, stored in the [history](#history) database at every deploy. A stack that hasn't been deployed since this was added has nothing stored, and isn't flagged until its next deploy.

#### Demo instance

To try the UI without a real deployment, `packages/gitainer` has a script that runs Gitainer from the checkout with a few throwaway stacks (in `packages/gitainer/demo`) deployed on the local docker. It needs `bun` and `docker`, and ports 3000 and 8080 free:

```
cd packages/gitainer
bun run demo           # sets it up from scratch and prints the URL and API key
bun run demo:tunnel    # the same, and shares the UI as a public URL through localtunnel (lt)
bun run demo:cleanup   # stops it and removes its containers, networks and files
```

The server runs with a clean environment, so the Env page shows only the demo's made-up variables. The demo covers a self-stack, a disabled stack, an undeployed one, a remote host that doesn't answer, a failed push in the history and a stale env. The API key is `demo`; `GITAINER_API_KEY` sets another one, and `GITAINER_DEMO_DIR` where its files go (default `$TMPDIR/gitainer-demo`).

#### History

Gitainer keeps what it did in a SQLite database, `gitainer.sqlite` in `GITAINER_DATA` (`/var/gitainer/data`): mount that directory as a volume to keep the history across container recreates. While Gitainer runs, the database has `gitainer.sqlite-wal` and `-shm` files beside it; back the three up together, or stop Gitainer first.

- **Events** are the results described under [POST Webhook](#post-webhook), stored as they're sent. Failed API calls are stored too, although they aren't sent to `POST_WEBHOOK`.
- **Deploys** are what an event did to each stack, with the command's output and the commit `main` was at. A push or env update records `deploy`, `down` (a deleted or disabled stack), `pull` (a failed pull), `rollback` and `self-update`; the API records `update`, `up`, `down` and `restart`. Actions started from the UI have the type `UI` (and the title `Gitainer: UI` in `POST_WEBHOOK`) instead of `Webhook`: the UI marks its requests with an `X-Gitainer-Source: ui` header.

A self-update is stored as handed off: the recreate's outcome is only [reported to `POST_WEBHOOK`](#self-updating-gitainer) by the helper container. The newest 2,000 events and 10,000 deploys are kept. Compose files in a payload are stored as they are in git, with their `${VARS}`, so the database holds no env values, only the hashes used to tell a [stale env](#stale-env). The file is readable only by its owner.

### Variables

Docker compose natively supports [variable interpolation](https://docs.docker.com/compose/environment-variables/variable-interpolation/) meaning that any variable in your environment will be visible to Gitainer. 

This is exceedingly useful for common repetitive fields such as your external domain or a root directory for bind mount volumes.

An example of how this can be used:

gitainer docker-compose.yaml define a variable
```
...
  environment:
    APP_DIR: /mnt/HDD/dockerStorage
```

from a compose file in Gitainer

```
...
  volumes:
    - $APP_DIR/mystack:/data
```

When actually deploying this compose file, it will be resolved as

```
  volumes:
    - /mnt/HDD/dockerStorage:/data
```

On startup, Gitainer checks the current set of environment variables against the last set of variables. If there is any differences, Gitainer will look through all stacks to see if any reference this variable and redeploy this stack if it does consume this variable. A stack consumes a variable when compose would interpolate it (`docker compose config --variables`), including in the fragments it imports; escaped `$$VAR` and variables in comments don't count.

#### Skipping stacks that aren't deployed

A stack that is only redeployed because it references a changed env var or a changed fragment is skipped if it has no containers, e.g. after `POST /api/stacks/:stackName/down` or a manual `docker compose down`. A rotated secret doesn't bring a stack back up in the middle of maintenance. It picks up the current env and fragments whenever it's next brought up. The skipped stacks are reported in the `POST_WEBHOOK` payload's `skippedStacks`.

A push that changes the stack's own compose file deploys it (unless the change is [comment-only](#comment-only-changes)), as do `POST /api/stacks/:stackName`, `/up` and `/restart`. So does a change to an env var that the stack's own [`x-gitainer-disabled`](#setting-the-flag-from-an-env-var) reads. A stack that is only stopped (`docker stop`) still has its containers, so it counts as deployed and is redeployed. If the check itself fails (e.g. an unreachable remote host), the stack is redeployed rather than skipped, so the real error is reported.

### Comment-only changes

A push that only changes comments in a stack's compose file doesn't redeploy the stack. Gitainer compares the stack as it was before the push with the pushed version, both with their fragments expanded, as parsed YAML. If they're equal, the stack is left alone and listed in the `POST_WEBHOOK` payload's `commentOnlyStacks`.

- The same goes for whitespace, quoting and key order, which don't change the parsed YAML either.
- A `#` inside a quoted string or a block scalar (e.g. a `command: |` script) isn't a comment, so changing it redeploys the stack.
- The two directives that look like comments still count: a `#! <fragment>` [import](#fragments) changes the expanded stack, and the `#@` [remote host](#remote-docker-host) line is compared separately.
- A comment-only edit to a fragment doesn't redeploy the stacks importing it. A change to the fragment's content does.
- Added, deleted and renamed stacks are always processed.
- Env changes still redeploy the stack, including one that changed since the last synthesis and arrives with a comment-only push.
- `POST /api/stacks/:stackName`, `/up` and `/restart` deploy the stack whatever the last commit changed.

### Infisical (secrets)
In addition to using environment variables, Gitainer also now supports Infisical for secrets and variables. Secrets will be pulled and merged into the set of environment varibles to be used as descibed above, on the following cadence:

- Gitainer service startup
- Git push
- and every 60s interval

Anytime variable changes are detected, any consuming services will be redeployed with the new value.

#### Priority

Infisical wins. Its secrets override any key of the same name in Gitainer's `environment:` or a mounted `.env`. The `.env` mount is meant as a cutover path for existing env files (see [Porting an external `.env` file](#porting-an-external-env-file)): once a variable is in Infisical, remove it from `.env`.

The exceptions are `SSH_AUTH_SOCK`, `HOME`, `USER`, `PATH` and `HOSTNAME`, which the processes Gitainer runs itself (ssh, docker, git) depend on. Infisical secrets with these names are ignored, with a warning. For example, a host's `SSH_AUTH_SOCK` in Infisical would point at a socket that doesn't exist inside the container, and every [remote host](#remote-docker-host) deploy would then fail with `Permission denied (publickey)`.

A key deleted from Infisical is unset on the next successful fetch, and stacks using it are redeployed. If Gitainer's `environment:` or `.env` also sets the key, Gitainer logs a warning, because that value comes back on the next restart. Keys aren't unset when a fetch returns no secrets at all.

#### Cache

After each successful fetch, the secrets are written to `$GITAINER_DATA/infisicalCache.json` (readable only by its owner). If Infisical can't be reached (e.g. it sits behind a reverse proxy that is down), Gitainer applies the cached secrets with the same priority as a live fetch, so a restart or push during an outage still deploys stacks with their last known values instead of blank or `.env` ones. The file holds your secrets in plain text, as do the `lastSynthesizedEnv` and `tmpEnv` snapshots next to it (all written readable only by their owner), so treat `$GITAINER_DATA` (and its backups) accordingly. Keys deleted from Infisical stay in the cache until the next successful fetch replaces it.

To set this up, provide the following environment variables in your Gitainer deployment

```
  environment: 
    INFISICAL_URL: <your infisical url>
    INFISICAL_CLIENT_ID=<your infisical machine client id>
    INFISICAL_CLIENT_SECRET=<your infisical machine client secret>

    INFISICAL_PROJECT_ID=<infisical project id>
    INFISICAL_PROJECT_ENVIRONMENT=<infisical project environment>
```

These only need to be provided until the first successful fetch. After it, Gitainer keeps them in `$GITAINER_DATA/infisicalBootstrap.json` (readable only by its owner) and loads any that aren't set from there on startup, before connecting to Infisical, so you can then drop them from `environment:` or delete the `.env` entirely. Any you do set explicitly win over the cached ones (e.g. to rotate the client secret). If `$GITAINER_DATA` is lost, provide them again.

They can also be stored in Infisical itself, e.g. to rotate the client secret there: add a second client secret to the machine identity, put it in Infisical as `INFISICAL_CLIENT_SECRET`, and revoke the old one once Gitainer has switched. When a fetch returns `INFISICAL_*` values that differ from the ones in use, Gitainer first logs in and fetches with them, and only switches (and saves them to `infisicalBootstrap.json`) if that works. Otherwise it logs an error once and keeps the current ones. Like other Infisical secrets, verified ones override `environment:` and `.env`.

### Remote Docker Host

Gitainer allows deploying a specific stack to a remote Docker host. To configure this, add a special comment prefix `#@` exactly at the very first line of your stack's `docker-compose.yaml`:

```yaml
#@ root@192.168.1.100:/opt/stack
services:
  app:
    image: alpine
    ...
```

The syntax for the remote host is:
```yaml
#@ [scheme://]user@host[:port][:path]
```
- **DOCKER_HOST**: If the scheme is omitted, it defaults to `ssh://` (e.g. `ssh://root@192.168.1.100`). Other schemes like `tcp://` are also supported.
- **COMPOSE_PROJECT_DIR**: If a path suffix is provided at the end (separated by a colon, e.g. `:/opt/stack` or `:opt/stack`), it will set the `COMPOSE_PROJECT_DIR` environment variable for the deployment (optional).

> [!WARNING]
> This directive is strictly validated and is **only allowed once per stack, exactly at the first line**. Pushing it elsewhere in the file will reject the push and return a validation error.

#### Exposing SSH Keys to Gitainer
Since Gitainer runs inside a Docker container, you must expose your host's SSH credentials to the container for remote SSH deployments:

##### Option A: Mount host's SSH directory (Simple)
Mount your local `.ssh` directory into the container's home directory (read-only) in your Gitainer deployment:
```yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ~/.ssh:/root/.ssh:ro
```

##### Option B: Mount the SSH Agent Socket (Recommended & Secure)
If you run `ssh-agent` on the host, mount the SSH agent socket and pass the environment variable:
```yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${SSH_AUTH_SOCK}:/ssh-agent
    environment:
      - SSH_AUTH_SOCK=/ssh-agent
```

### Self-Updating Gitainer

Gitainer can manage its own deployment as a normal stack, so pushing a change to it (e.g. bumping the image tag) pulls the new image and redeploys itself. This isn't automatic like other stacks: normally a stack update runs `down` before `pull`/`up`, but if the stack being updated is gitainer's own container, that `down` would kill the very process performing the update. To make this safe, set `GITAINER_SELF_STACK` to the name of the stack that is gitainer's own deployment (e.g. `gitainer` if it lives at `stacks/gitainer/docker-compose.yaml`):

```yaml
environment:
  GITAINER_SELF_STACK: gitainer
  # GITAINER_SELF_UPDATE_HELPER_IMAGE: docker:<version>-alpine<version> (defaults to the docker image gitainer is built on, override for air-gapped/mirrored registries)
```

With `GITAINER_SELF_STACK` set, a push that touches that stack pulls the new image in-process (safe - it never touches the running container), then hands the actual recreate off to a short-lived, detached helper container launched via the Docker socket. That helper survives gitainer's own container being replaced, since it's a sibling container rather than a child process.

A few things to know:
- **Fire-and-forget, no auto-rollback.** Once the helper container is launched, gitainer can't observe or roll back the outcome the way it does for other stacks - a broken self-update must be fixed forward with another push, not reverted automatically.
- **The helper reports back.** With `POST_WEBHOOK` set, the helper POSTs the recreate's outcome there itself once it's done, as a second notification after the usual one from gitainer (which only says the update was handed off). The `title` matches what triggered it, and it carries the `docker compose up` output:
  ```json
  { "title": "Gitainer: Git Push", "stackName": "gitainer", "msg": "Successfully self-updated stack gitainer: the helper container recreated it", "output": "..." }
  ```
  or, if the recreate failed:
  ```json
  { "title": "Gitainer: Git Push", "stackName": "gitainer", "err": "Self-update of stack gitainer failed in the helper container (exit code 1): ...", "output": "..." }
  ```
  The helper runs on Docker's default bridge network, so `POST_WEBHOOK` has to be reachable from there: a compose service name only resolvable on gitainer's own network, or `localhost`, won't work.
- **Deletes are protected.** Pushing a deletion of the self-stack is refused (the running container is left untouched) rather than silently tearing down the only thing that could push a fix. The refusal is reported as a `warnings` entry on the synthesis result / `POST_WEBHOOK` payload.
- **No remote hosts.** A `#@` remote-host comment on the self-stack is rejected - gitainer can only self-update the host it's actually running on.
- **Misconfiguration risk.** If `GITAINER_SELF_STACK` doesn't match gitainer's actual compose project, self-update protection silently doesn't apply and the original down-yourself problem can reoccur. Gitainer logs a startup warning on a mismatch it can detect, but double-check the name matches your deployment.

#### Migrating an existing deployment into a self-stack

If you're already running gitainer (or any compose deployment) via `docker compose up -d` outside of gitainer's management, you can bring it under self-update with no downtime as long as the compose project name stays the same before and after:

1. Find the project name your current deployment is running under (it defaults to the directory name you ran `docker compose up` from, or check with `docker inspect <container> --format '{{index .Config.Labels "com.docker.compose.project"}}'`).
2. Use that exact name as your self-stack name going forward - it needs to match both `GITAINER_SELF_STACK` and the `stacks/<name>/` directory you push to, so that the sibling container's `up -d --force-recreate` recognizes your existing containers as the same project and replaces them in place instead of standing up a second, conflicting copy.
3. Add `GITAINER_SELF_STACK: <name>` to your current deployment's environment and restart it once (`docker compose up -d`) to pick it up. This is the only manual step - after this, updates flow through git pushes.
4. Clone gitainer's repo, create `stacks/<name>/docker-compose.yaml` with the same service definitions you're already running, commit, and push. Gitainer treats this first push the same as any other self-update (routed through the safe `composeSelfUpdate` path), so it force-recreates your existing containers under the matching project rather than starting fresh ones.

##### Porting an external `.env` file

If your existing deployment sources variables from a `.env` file next to its compose file (docker compose's native auto-loading), that file has no equivalent once the compose file itself moves into gitainer's git repo - the "[Variables](#variables)" mechanism above needs those variables in gitainer's own process environment, not in a file sitting next to a compose file gitainer doesn't run from.

The simplest way to carry it over is to mount the existing `.env` file straight into gitainer's container: Bun (which gitainer runs on) automatically loads a `.env` file from its working directory at startup, so mounting yours to `/home/gitainer/.env` makes every variable in it available for compose variable interpolation across all your managed stacks, exactly as if it had been set under `environment:` directly:

```yaml
services:
  gitainer:
    volumes:
      - ./path/to/existing/.env:/home/gitainer/.env:ro
      ...
```

Since it's only read once at process startup, edits to the mounted file require restarting the gitainer container to take effect - the same caveat that already applies to variables set directly under `environment:`.

This works for self-stacks too, not just other managed stacks: gitainer forwards its own environment (mounted `.env` included) into the detached sibling container that performs the self-update recreate, so `${VAR}`-style interpolation in the self-stack's own compose file resolves the same way there as it does everywhere else.

## Fragments

Docker compose also natively supports [fragments](https://docs.docker.com/reference/compose-file/fragments/). The limitation with fragments in regular Docker Compose is they require the anchor to be resolved within the same file, because [YAML documents are independant](https://github.com/docker/compose/issues/5621#issuecomment-499021562). Ultimately this means that they cannot be reused across multiple files when using built in options such as [merge](https://docs.docker.com/reference/compose-file/merge/) or [include](https://docs.docker.com/reference/compose-file/include/).

Docker compose also allows for [YAML merge syntax](https://yaml.org/type/merge.html) to add properties to existing mappings

Gitainer solves this by introducing a new concept of importing within Docker Compose. In short, adding a special comment allows you to patch in your desired fragment, before `docker compose` is ever called. This allows us to get around these limitations, without any actual copy and pasting required.

### Constants Example

Let say in this example I want every service to have some common properties for restarting and grace period. I can define a fragment like this in the repo with an anchor called `common`

fragments/commonProperties.yaml
```
x-common-stuff: &common
  restart: unless-stopped
  stop_grace_period: 10m
```

then in my stack I will import it before my services and then reference the anchor `common` and merge the properties in.

```
#! fragments/commonProperties.yaml
services:
  hello:
    image: nginx
    <<: [*common]
```

Gitainer will patch in the file before it runs `docker compose` resulting in this docker-compose.yaml

```
# fragments start

# fragments/commonProperties.yaml
x-common-stuff: &common
  restart: unless-stopped
  stop_grace_period: 10m

# fragments end

services:
  hello:
    image: nginx
    <<: [*common]
```

### Example with anchor using other anchor

Let say in this example I want a fragment that sets some container labels based on some value specific to this stack. This fragment defines an anchor `specific_labels` and expects that two anchors are defined `container_name` and `url`.

fragments/specificLabel.yaml
```
x-specific-labels: &specific_labels
  dashboardlabel.name: *container_name
  dashboardlabel.url: *url
```

then in my stack I will import it before my services and but after `container_name` and `url` anchors have been defined

```
x-configuration:
  x-name: &container_name myname
  x-url: &url https://myname.mydomain.com

#! fragments/specificLabel.yaml
services:
  hello:
    image: nginx
    labels:
      <<: [*specific_labels]
```

Gitainer will patch in the file before it runs `docker compose` resulting in this docker-compose.yaml

```
x-configuration:
  x-name: &container_name myname
  x-url: &url https://myname.mydomain.com

# fragments start

# fragments/specificLabel.yaml
x-specific-labels: &specific_labels
  dashboardlabel.name: *container_name
  dashboardlabel.url: *url

# fragments end

services:
  hello:
    image: nginx
    labels:
      <<: [*specific_labels]
```

### Fragment Aliases

Often you'll want to reuse the same fragment multiple times in a single compose file. This is normally impossible since duplicate anchors would collide. 
Gitainer solves this by introducing **Fragment Aliases**. When you provide the `as <alias>` syntax, Gitainer suffixes all defined and referenced anchors (`&anchor` and `*anchor`) inside the fragment with `-<alias>`.

fragments/db.yaml
```yaml
x-database: &postgres
  image: postgres:15
  restart: unless-stopped
  environment:
    POSTGRES_PASSWORD: *db_password
```

In your stack `docker-compose.yaml`:
```yaml
x-secrets:
  x-primary-pw: &db_password-primary "securepass1"
  x-replica-pw: &db_password-replica "securepass2"

#! fragments/db.yaml as primary
#! fragments/db.yaml as replica

services:
  app-db:
    <<: *postgres-primary
    container_name: primary-db
  
  replica-db:
    <<: *postgres-replica
    container_name: replica-db
```

### Prefix Entrypoint

Gitainer provides a custom property `prefix_entrypoint` to easily prepend setup commands (like symlinking, pulling dependencies, or calling webhooks) before your container's original `ENTRYPOINT` and `CMD` execute, without losing the image's downstream default execution sequence.

This is highly useful because standard Docker Compose requires you to duplicate and hardcode the image's original entrypoint and command if you override the entrypoint to run a custom script. With `prefix_entrypoint`, you can leave the command and entrypoint unspecified, and Gitainer will resolve them dynamically.

#### Example:
In your stack's `docker-compose.yaml`:
```yaml
services:
  web:
    image: nginx:alpine
    prefix_entrypoint:
      - curl -X POST https://api.webhooks.com/container-started
```

Under the hood, Gitainer automatically pulls the image, inspects its embedded metadata (Entrypoint and Cmd), and generates a `/bin/sh -c` wrapper script using `exec "$@"` to pass the image's native execution arguments safely.

### Shutdown Hook

A stack can define a top-level `x-shutdown-hook` with commands to run right before Gitainer downs the stack, e.g. to take a backup or flush state. It accepts a single command string or a list of command strings:

```yaml
x-shutdown-hook:
  - docker exec mydb pg_dump -U postgres -f /backups/pre-shutdown.sql
  - curl -fsS -X POST https://api.webhooks.com/stack-stopping

services:
  mydb:
    image: postgres
    container_name: mydb
```

- Commands run in order with `sh -c` inside the Gitainer container, with the same environment as the compose commands. For a [remote host](#remote-docker-host) stack `DOCKER_HOST` is set, so `docker ...` commands target the remote host.
- The hook runs whenever the stack is downed: when a stack is modified, deleted, renamed or [disabled](#disabling-a-stack) by a push, on a forced reload through `POST /api/stacks/:stackName`, and on `POST /api/stacks/:stackName/down` or `/restart`.
- The **newest** version of the hook always runs:
  - **Modify or rename:** the hook from the version being pushed runs, not the one currently deployed. Adding a hook takes effect on the push that adds it, and pushing a fixed hook unblocks a stack whose deployed hook is broken.
  - **Delete, or a rename out of the `stacks/<name>/` pattern:** there is no incoming version, so the hook from the last committed version runs. If that hook is broken, push a fix first, then delete.
  - **`POST /api/stacks/:stackName`, `/down` or `/restart`:** the hook from the current version in the repo runs.
- If any command exits non-zero, the remaining commands are skipped, the stack is **not** downed, and the update fails with the command's output (a push is rejected and rolled back like any other synthesis failure).
- The hook is skipped if the stack has no containers, so it never blocks deploying over a stack that isn't running. If a hook is broken on a running stack, push a fixed hook.
- Not run for the [self-stack](#self-updating-gitainer), which is recreated by a helper container rather than downed.

> [!NOTE]
> On a modify, the new hook runs against the **old, still-running** stack, before any of the pushed changes are deployed. A hook that depends on something only the pushed version introduces, such as a container that was added or renamed, fails on that push because it doesn't exist yet. When a push adds or changes a hook along with such changes, make the hook work against the old stack as well, or tolerate what's missing (e.g. `docker exec new-db ... || true`).

### Disabling a stack

Set the top-level `x-gitainer-disabled: true` to keep a stack down while leaving it in the repo:

```yaml
x-gitainer-disabled: true
services:
  app:
    image: nginx
```

- The push that adds the flag downs the stack, running its [shutdown hook](#shutdown-hook). While the flag is set, no push, env change or fragment change deploys it, and its images aren't pulled. `POST /api/stacks/:stackName`, `/up` and `/restart` refuse it with a 400; `/down` still works.
- Remove the flag, set it to `false` or comment it out, and push to deploy the stack again. The flag is read from the parsed YAML, so a commented-out `# x-gitainer-disabled: true` has no effect.
- A hard-coded value has to be a YAML boolean. Any other value, e.g. `"true"` or `yes`, fails the push.
- Disabled stacks are listed in the `POST_WEBHOOK` payload's `disabledStacks`.
- The [self-stack](#self-updating-gitainer) can't be disabled: a push that sets the flag on it leaves the running gitainer container untouched and adds a `warnings` entry, like deleting it.

#### Setting the flag from an env var

The flag can read an env var, so a stack can be turned off and on from [Infisical](#infisical-secrets) without a commit:

```yaml
x-gitainer-disabled: ${DISABLE_APP:-false}
services:
  app:
    image: nginx
```

- The value is interpolated by compose itself, so the usual [syntax](https://docs.docker.com/compose/environment-variables/variable-interpolation/) applies (`$VAR`, `${VAR}`, `${VAR:-default}`). It has to come out as `true` or `false`; anything else fails the push, or the env update. A variable that is unset with no default counts as `false`.
- It takes effect when the env changes, like any other env-driven redeploy: on an Infisical poll, or a Gitainer restart (with `STACK_UPDATE_ON_ENV_CHANGE`). Setting the variable to `true` downs the stack, and setting it back to `false` deploys it again. This is the one env change that isn't [skipped](#skipping-stacks-that-arent-deployed) for a stack with no containers.
- `POST /api/stacks/:stackName`, `/up` and `/restart` check the interpolated value.
- A commented-out flag still has no effect.

## Motivation

Since getting in to selfhosting about 2 years ago, I have used Portainer to manage Docker stacks. After using it for a while, I found many areas in which I thought the core experience of managing stacks could be improved.

Most people already use git repos to manage their stacks, or some structured directories on the host machine where they manually run `docker compose` for when making changes. For myself, I used a git repo on my local Gitea instance, which contained a custom action script that could gather the diff of my changes and then make POST requests to the Portainer API.

This was a clunky solution for many reasons and I ultimately came to the conclusion that building something simple to automate this process would be more valuable and extensible for the future and may also help others that are looking for this sort of solution.

## example integrations

Gitainer's [manager UI](#manager-ui) covers stack status, stack actions and the env. It has no git editor, logs or container-level actions, but Gitainer plays well with other existing tools for these.

Keep your compose files managed by Gitainer for editing / deployments and handle the rest with other tooling.

This is not an exhaustive list but just a shortlist of things that I am experimenting with to improve my own homelab.

### [Dockwatch](https://github.com/Notifiarr/dockwatch)
You can use dockwatch to monitor containers managed by Gitainer and even automatically schedule checking for updates. 
This is a super powerful combination with Gitainer for infrastructure as code and Dockwatch for managing homelab operations.

### [VSCode Web (web interface to a git repo)](https://hub.docker.com/r/linuxserver/code-server)

Concerned about not being able to edit stacks away from your desktop? Fear not, you can use something like VSCode web to have an on the go solution. 

This also has the benefit of being able to install extensions directly into the web interface for YAML editing (like my [dotenv autocomplete fork with YAML support](https://github.com/martindmtrv/dotenv-vscode-stripped/tree/yaml))

### [Gitea (mirror repository)](https://docs.gitea.com/usage/repo-mirror#pulling-from-a-remote-repository)

You can mirror your Gitainer repo to Gitea to have an interface to view the repo status and commit history from anywhere. 

Most importantly, you can have issue tracking for your stacks, right with the repo making it easy to track any bugs or features you want to add to your homelab

![gitea mirror example](./assets/gitea-mirror.png)

### [Portainer (minus stack creation)](https://docs.portainer.io/start/install-ce/server/docker/linux)

I know one of the reasons I built this project is to avoid using Portainer to manage my Docker stacks, but it is actually a pretty powerful tool for monitoring.

If you have gotten used to using Portainer for managing containers and viewing logs, you can still do so! Use Gitainer to version your compose files and use portainer for any container management, so you get the best of both worlds

All of your stacks will be visible with "limited" access because they are created outside of Portainer, but containers can still be accessed directly and stopped, restarted, recreated and updated.

![portainer limited access stacks](./assets/portainer-limit-access.png)

## migration from portainer

Go into Portainer webui and download a backup file:

portainer > settings > download backup file

Create a temp directory on the host machine and put the portainer-backup*.tar.gz file in it

```
mkdir -p /tmp/migration
cp portainer-backup*.tar.gz /tmp/migration/
```

Run Docker command with a one off container, with the /var/gitainer/migration directory mounted as the directory we just created.

```
docker run --rm -it -v /tmp/migration:/var/gitainer/migration ghcr.io/martindmtrv/gitainer migrate-portainer
```

Now copy the contents of the output folder to your Gitainer repo:

```
cp -r /tmp/migration/* <my-gitainer-repo>/
```


Verify the changes, then commit and push

```
git add .
git commit -m "migrating from portainer"
git push
```
