# Gitainer

A git server to manage docker stacks for a homelab

## support my work

Leave me a tip with lightning!

<a href="bitcoin:?lno=lno1zrxq8pjw7qjlm68mtp7e3yvxee4y5xrgjhhyf2fxhlphpckrvevh50u0q2rkvqf2wyanp7swjke685p0hkmmeuckmlf93p0d6kwhez4elu2ngqszyudq885cu586ff7n5zuv6ekt6uswfm3t49g3vztwjnp2s3047yjsqve58akwjaw8er89dpvc2yf383amedxkelsyl3d8adrrk7cn0nkvasmzuzpxkdy96ad3cl4h5nm7dptl2f2jq0d4r2zk6pxxcyg53kc489hnu0hqvalhhgsnv90fhumxm29tkznaqqqsc96fxs592lh92v6l7rcw334sng" class="button" style="font-size:24px">
  ⚡ Lightning Tip
</a>

## example integrations

Gitainer does not provide a UI for access, but does play well with other Docker tools! Keep your compose files managed Gitainer for editing / deployments and handle operations with other tooling

### portainer
If you have gotten used to using Portainer for managing containers and viewing logs, you can still do so! Use Gitainer to version your compose files and use portainer for any container management!

All of your stacks will be visible with "limited" access because they are created outside of Portainer, but containers can still be accessed directly and stopped, restarted, and recreated.

![portainer limited access stacks](./assets/portainer-limit-access.png)

You are still able to stop/restart/repull images this way, just not editing the compose files that are managed by Gitainer.


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
