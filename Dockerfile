FROM docker:27.1.2-alpine3.20

# Install bun
RUN apk update && apk add bash npm git
RUN apk --no-cache add ca-certificates wget
RUN wget -q -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub
RUN wget https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.28-r0/glibc-2.28-r0.apk
RUN apk add --no-cache --force-overwrite glibc-2.28-r0.apk
RUN npm install -g bun

# copy package.json
RUN mkdir -p /home/node/app/node_modules
WORKDIR /home/node/app
COPY package*.json ./

# install deps
RUN bun install

COPY . .
RUN mkdir -p /var/gitainer/repo
EXPOSE 3000
EXPOSE 8080

ENV GIT_ROOT=/var/gitainer/repo
ENV GITLIST=http://gitlist:80

# make all git repos safe
RUN git config --global --add safe.directory '*'

CMD [ "bun", "run", "start" ]
