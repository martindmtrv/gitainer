FROM docker:27.1.2-alpine3.20

# setup go 
RUN apk add --no-cache git make musl-dev go

# Configure Go
ENV GOROOT /usr/lib/go
ENV GOPATH /go
ENV PATH /go/bin:$PATH

RUN mkdir -p ${GOPATH}/src ${GOPATH}/bin

# Install bun
RUN apk update && apk add bash npm git diffutils
RUN apk --no-cache add ca-certificates wget
COPY build-deps/sgerrand.rsa.pub /etc/apk/keys/sgerrand.rsa.pub
COPY build-deps/glibc-2.28-r0.apk .
RUN apk add --no-cache --force-overwrite glibc-2.28-r0.apk
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
ENV GITLIST=http://gitlist:80
ENV GITAINER_DATA=/var/gitainer/data
ENV REPO_NAME=docker
ENV GIT_BRANCH=main

ENV MIGRATION_PATH=/var/gitainer/migration
RUN echo "cd /home/gitainer && bun run migrate" > /bin/migrate-portainer
RUN chmod +x /bin/migrate-portainer

# make all git repos safe
RUN git config --global --add safe.directory '*'

CMD [ "bun", "run", "start" ]
