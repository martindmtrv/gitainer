import { normalize } from "path";
import { DockerClient } from '../docker/DockerClient';
import { GitainerServer } from '../git/GitainerServer';
import { WebhookServer } from "../webhooks/WebhookServer";

const resourcesDir = normalize(process.cwd() + "/resources");
const bareDir = resourcesDir + "/bare";

const docker = new DockerClient();
const gitainer = new GitainerServer(bareDir, docker);

const bareRepo = await gitainer.initRepo();
const webhook = new WebhookServer(docker, bareRepo);

gitainer.listen(3000);
webhook.listen(8080);
