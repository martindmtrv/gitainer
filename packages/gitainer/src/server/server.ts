import { DockerClient } from '../docker/DockerClient';
import { GitainerServer } from '../git/GitainerServer';
import { WebhookServer } from "../webhooks/WebhookServer";
import { updateProcessEnv } from "../infisical/InfisicalProvider";

// load dynamic env from infisical
await updateProcessEnv();

const bareDir = process.env.GIT_ROOT as string;

const docker = new DockerClient();
const gitainer = new GitainerServer(
  process.env.REPO_NAME as string,
  process.env.GIT_BRANCH as string,
  bareDir,
  process.env.GITAINER_DATA as string,
  process.env.FRAGMENTS_PATH as string,
  process.env.STACKS_PATH as string,
  docker,
  !!process.env.STACK_UPDATE_ON_ENV_CHANGE,
  process.env.POST_WEBHOOK as string,
  process.env.GITAINER_SELF_STACK,
);

const bareRepo = await gitainer.initRepo();
const webhook = new WebhookServer(docker, bareRepo, gitainer);

gitainer.listen(3000);
webhook.listen(8080);

if (process.env.GITAINER_SELF_STACK) {
  docker.getOwnComposeProject().then(ownProject => {
    if (ownProject && ownProject !== process.env.GITAINER_SELF_STACK) {
      console.warn(`WARNING: GITAINER_SELF_STACK is set to "${process.env.GITAINER_SELF_STACK}" but this container's compose project is "${ownProject}" - self-update protection will not apply to your actual deployment until these match.`);
    }
  });
}

if (process.env.INFISICAL_URL) {
  setInterval(async () => {
    if (await updateProcessEnv()) {
      await gitainer.checkForStackEnvUpdate();
    }
  }, 60_000);
}