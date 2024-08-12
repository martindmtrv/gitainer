import { Git as GitServer, type PushData } from 'node-git-server';
import { normalize } from "path";
import { GitConsumer } from '../git/GitConsumer';

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

  push.accept();
});

repos.listen(3000, undefined, async () => {
  // create the default repo
  if (!(await repos.exists("docker"))) {
    await repos.create("docker", (err) => err && console.log(err));
  }

  const bareRepo = new GitConsumer(bareDir + "/docker.git");
  const latestChanges = await bareRepo.getLatestChanges();

  console.log("===", latestChanges[0].file, "===");
  console.log(await bareRepo.getFileContents(latestChanges[0].file));


  console.log(await repos.list());
  console.log(`node-git-server running at http://localhost:3000`);
});