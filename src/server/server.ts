import { DockerClient } from '../docker/DockerClient';
import { GitainerServer } from '../git/GitainerServer';
import { WebhookServer } from "../webhooks/WebhookServer";

const bareDir = process.env.GIT_ROOT as string;

const docker = new DockerClient();
const gitainer = new GitainerServer(bareDir, docker);

const bareRepo = await gitainer.initRepo();
const webhook = new WebhookServer(docker, bareRepo);

gitainer.listen(3000);
webhook.listen(8080);
