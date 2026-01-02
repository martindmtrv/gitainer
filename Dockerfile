FROM docker:27.1.2-alpine3.20

# setup go 
RUN apk add --no-cache git make musl-dev go curl

# Configure Go
ENV GOROOT /usr/lib/go
ENV GOPATH /go
ENV PATH /go/bin:$PATH

RUN mkdir -p ${GOPATH}/src ${GOPATH}/bin

# Install bun
RUN apk update && apk add bash npm git diffutils
RUN apk --no-cache add ca-certificates wget
RUN npm install -g bun

# copy package.json
RUN mkdir -p /home/gitainer/node_modules
WORKDIR /home/gitainer
COPY package*.json ./

# install deps
RUN bun install

COPY . .
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

ENV MIGRATION_PATH=/var/gitainer/migration
RUN echo "cd /home/gitainer && bun run migrate" > /bin/migrate-portainer
RUN chmod +x /bin/migrate-portainer

# make all git repos safe
RUN git config --global --add safe.directory '*'

CMD [ "bun", "run", "start" ]
