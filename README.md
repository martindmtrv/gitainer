# Gitainer

A git server to manage docker stacks for a homelab

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
