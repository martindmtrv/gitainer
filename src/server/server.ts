import { Git as GitServer, type PushData } from 'node-git-server';
import { normalize } from "path";
import { GitConsumer } from '../git/GitConsumer';
import { DockerClient } from '../docker/DockerClient';
import { GitChangeType } from '../git/GitChange';
import { ResetMode } from 'simple-git';

const resourcesDir = normalize(process.cwd() + "/resources");
const bareDir = resourcesDir + "/bare";

const repos = new GitServer(bareDir, {
  autoCreate: false,
});

const docker = new DockerClient();

async function synthesisTime() {
  const bareRepo = new GitConsumer(bareDir + "/docker.git");
  const latestChanges = await bareRepo.getChanges("HEAD");
  const stackPattern = /stacks\/([a-zA-Z-_]*)\/docker-compose\.yaml/;

  try {
    const stackChanges = latestChanges
    .filter(change => 
      [GitChangeType.ADD, GitChangeType.MODIFY].includes(change.type) &&
      stackPattern.test(change.file)
    );

    if (stackChanges.length == 0) {
      console.log("Change did not contain any stack changes, so this synthesis is a noop");
    }

    // apply each stack change
    for (const change of stackChanges) {
      const stackName = (stackPattern.exec(change.file) as RegExpExecArray)[1];
      console.log(`== stack synthesis -> ${stackName} ==`);
      await docker.composeUpdate(await bareRepo.getFileContents(change.file) as string, stackName);
    }

    // TODO: notify the user somehow

    console.log("Synthesis succeeded for", stackChanges.length, "stack(s)");
  } catch (e: any) {
    console.error(e);
    console.log("Got an error during synthesis, removing the bad commit", await bareRepo.repo.log({ maxCount: 1 }));

    // delete this commit
    await bareRepo.repo.reset(ResetMode.SOFT, ["HEAD^"]);

    // TODO: notify the user somehow
  }
}

let synthesisRunning = false;

repos.on('push', async (push: PushData & { log: (a?: string) => void }) => {
  console.log(`Received a push ${push.repo}/${push.commit} ( ${push.branch} )`);

  if (synthesisRunning) {
    console.error("Synthesis is currently running, rejecting push");
    push.reject(409, "Synthesis in progress, please wait until it completes");
    return;
  }

  push.log();
  push.log('Thanks for pushing! Gitainer will try to synthesize your stacks defined under /stacks now');
  push.log('If it fails, the change will be reverted by the server');
  push.log('Additional pushes will be rejected until synthesis is complete or rolls back');
  push.log();

  push.accept();

  synthesisRunning = true;

  // attempt synth after a short delay
  setTimeout(async () => {
    synthesisTime();
    synthesisRunning = false;
  }, 2000);
});

repos.listen(3000, undefined, async () => {
  // create the default repo
  if (!(await repos.exists("docker"))) {
    await repos.create("docker", (err) => err && console.log(err));
  }

  synthesisTime();

  console.log(await repos.list());
  console.log(`node-git-server running at http://localhost:3000`);
});