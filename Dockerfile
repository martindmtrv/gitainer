FROM node:22-alpine

RUN apk update && apk add git

RUN mkdir -p /home/node/app/node_modules
WORKDIR /home/node/app
COPY package*.json ./

RUN npm install
COPY --chown=node:node . .
RUN mkdir -p /var/gitainer/repo
EXPOSE 3000
EXPOSE 8080

ENV GIT_ROOT=/var/gitainer/repo
ENV GITLIST=http://gitlist:80

CMD [ "npm", "run", "start" ]

