# Docker version for both stages and for the self-update helper image. Match it to the Docker
# host: bump it here only, or override with `--build-arg DOCKER_VERSION=...`.
ARG DOCKER_VERSION=29.7.2
ARG ALPINE_VERSION=3.24

# ==============================================================================
# Test Stage
# ==============================================================================
FROM docker:${DOCKER_VERSION}-dind-alpine${ALPINE_VERSION} AS test
ARG DOCKER_VERSION
ARG ALPINE_VERSION
ENV GITAINER_SELF_UPDATE_HELPER_IMAGE=docker:${DOCKER_VERSION}-alpine${ALPINE_VERSION}

# Install dependencies (git for tests, bash for scripts)
RUN apk add --no-cache git make musl-dev go curl

# Install bun
RUN apk update && apk add bash git diffutils
RUN apk --no-cache add ca-certificates wget curl
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Copy dependency definitions
COPY bun.lockb packages/gitainer/package.json ./
RUN bun install

# Copy source
COPY packages/gitainer/ .

# Use custom entrypoint
COPY packages/gitainer/test-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/test-entrypoint.sh

ENTRYPOINT ["test-entrypoint.sh"]
CMD ["bun", "test"]


# ==============================================================================
# Production Stage
# ==============================================================================
FROM docker:${DOCKER_VERSION}-alpine${ALPINE_VERSION} AS production
ARG DOCKER_VERSION
ARG ALPINE_VERSION

LABEL org.opencontainers.image.source=https://github.com/martindmtrv/gitainer
LABEL org.opencontainers.image.description="Simple Git-based container management platform for Docker Standalone"

# setup go 
RUN apk add --no-cache git make musl-dev go curl openssh-client sshpass

# Configure SSH to skip host key checking for remote hosts
RUN mkdir -p /etc/ssh && \
    echo -e "Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n" >> /etc/ssh/ssh_config

# Configure Go
ENV GOROOT=/usr/lib/go
ENV GOPATH=/go
ENV PATH=/go/bin:$PATH

RUN mkdir -p ${GOPATH}/src ${GOPATH}/bin

# Install bun
RUN apk update && apk add bash git diffutils
RUN apk --no-cache add ca-certificates wget curl
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# copy package.json
RUN mkdir -p /home/gitainer/node_modules
WORKDIR /home/gitainer
COPY bun.lockb ./
COPY packages/gitainer/package.json ./

# install deps
RUN bun install

COPY packages/gitainer/ .
RUN mkdir -p /var/gitainer/repo
RUN mkdir -p /var/gitainer/data
EXPOSE 3000
EXPOSE 8080

ENV GIT_ROOT=/var/gitainer/repo
ENV STACKS_PATH=/var/gitainer/stacks
ENV FRAGMENTS_PATH=fragments
ENV GITAINER_DATA=/var/gitainer/data
ENV REPO_NAME=docker
ENV GIT_BRANCH=main
ENV ENABLE_RAW_API=0
ENV GITAINER_SELF_UPDATE_HELPER_IMAGE=docker:${DOCKER_VERSION}-alpine${ALPINE_VERSION}

ENV MIGRATION_PATH=/var/gitainer/migration
RUN echo "cd /home/gitainer && bun run migrate" > /bin/migrate-portainer
RUN chmod +x /bin/migrate-portainer

# make all git repos safe
RUN git config --global --add safe.directory '*'

CMD [ "bun", "run", "start" ]
