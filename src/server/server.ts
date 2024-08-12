import { Git as GitServer, HttpDuplex, Service, type PushData } from 'node-git-server';
import { simpleGit } from 'simple-git';
import { normalize } from "path";

const resourcesDir = normalize(__dirname + "../../../resources");
const bareDir = resourcesDir + "/bare";

const repos = new GitServer(bareDir, {
  autoCreate: false,
});

repos.on('push', async (push: PushData & { log: (a?: string) => void }) => {
  console.log(`push ${push.repo}/${push.commit} ( ${push.branch} )`);

  push.log();
  push.log('Hey!');
  push.log('Checkout these other repos:');
  for (const repo of await repos.list()) {
    push.log(`- ${repo}`);
  }
  push.log();


  // push.reject(404, "not found");
  push.accept();
});

repos.on('fetch', (fetch) => {
  console.log(`fetch ${fetch.commit}`);
  fetch.accept();
});

repos.listen(3000, undefined, async () => {
  // create the default repo
  if (!(await repos.exists("docker"))) {
    await repos.create("docker", (err) => console.log(err));
  }

  const bareRepo = await simpleGit(bareDir + "/docker.git");

  const show = await bareRepo.show(["--name-status", "--oneline", "HEAD"]);

  // get the first file and change status
  const file = show.split("\n")[1].split("\t");
  console.log(file);

  // print file contents
  console.log(file[1], "\n", await bareRepo.show([`main:${file[1]}`]));


  console.log(await repos.list());
  console.log(`node-git-server running at http://localhost:3000`);
});