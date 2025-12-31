import { DockerClient } from '../docker/DockerClient';
import { GitainerServer } from '../git/GitainerServer';
import { WebhookServer } from "../webhooks/WebhookServer";
import { updateProcessEnv } from "../infisical/InfisicalProvider";

// load dynamic env from infiscal
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
);

const bareRepo = await gitainer.initRepo();
const webhook = new WebhookServer(docker, bareRepo, gitainer);

gitainer.listen(3000);
webhook.listen(8080);

if (process.env.INFISICAL_URL) {
  setInterval(async () => {
    await updateProcessEnv();
    await gitainer.checkForStackEnvUpdate();
  }, 60_000);
}