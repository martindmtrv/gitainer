# Gitainer

Simple Git-based container management platform for Docker Standalone


<a href="bitcoin:?lno=lno1zrxq8pjw7qjlm68mtp7e3yvxee4y5xrgjhhyf2fxhlphpckrvevh50u0q2rkvqf2wyanp7swjke685p0hkmmeuckmlf93p0d6kwhez4elu2ngqszyudq885cu586ff7n5zuv6ekt6uswfm3t49g3vztwjnp2s3047yjsqve58akwjaw8er89dpvc2yf383amedxkelsyl3d8adrrk7cn0nkvasmzuzpxkdy96ad3cl4h5nm7dptl2f2jq0d4r2zk6pxxcyg53kc489hnu0hqvalhhgsnv90fhumxm29tkznaqqqsc96fxs592lh92v6l7rcw334sng" class="button" style="font-size:24px">
  Support my work with Lightning ⚡
</a>

## Features

- All the benefits of Git such as versioning, portability, etc.
- Pass through Variables and YAML fragments to keep your stacks DRY
- Lightweight HTTP API to trigger stack actions from CI/CD pipelines
- POST webhook option for update responses

## Usage

Deploy the stack with docker compose
```
services:
  gitainer:
    image: chromart/gitainer
    volumes:
      - ./resources/bare:/var/gitainer/repo      
      - ./resources/data:/var/gitainer/data
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - 3000:3000 # git server
      - 8080:8080 # webui and webhooks
    environment:
      STACK_UPDATE_ON_ENV_CHANGE: 1
      POST_WEBHOOK: https://ntfy.chromart.cc/gitainer

      # defaults
      # GIT_ROOT: /var/gitainer/repo
      # GITLIST: http://gitlist:80
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
# todo auto populate the stacks dir
mkdir -p stacks/mystack
vi stacks/mystack/docker-compose.yaml
```

Push the changes
```
git add .
git commit -m "my first stack"
git push
```

## Motivation

Since getting in to selfhosting about 2 years ago, I have used Portainer to manage Docker stacks. After using it for a while, I found many areas in which I thought the core experience of managing stacks could be improved.

Most people already use git repos to manage their stacks, or some structured directories on the host machine where they manually run `docker-compose` for when making changes. For myself, I used a git repo on my local Gitea instance, which contained an action that could gather the diff of my changes and then make POST requests to the Portainer API. 

This was a clunky solution for many reasons and I ultimately came to the conclusion that building something simple to automate this process would be more valuable and extensible for the future and may also help others that are looking for this sort of solution.

## example integrations

Gitainer does not provide a UI for access, but does play well with other existing tools for this.

Keep your compose files managed Gitainer for editing / deployments and handle operations with other tooling.

This is not an exhaustive list but just a shortlist of things that I am experimenting with to improve my own homelab.

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
docker run --rm -it -v /tmp/migration:/var/gitainer/migration gitea.chromart.cc/martin/gitainer migrate-portainer
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
