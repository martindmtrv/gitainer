import { Git as GitServer, type PushData } from 'node-git-server';
import { GitConsumer } from './GitConsumer';
import { ResetMode } from 'simple-git';
import { GitChangeType, type GitChange } from './GitChange';
import type { DockerClient } from '../docker/DockerClient';
import { $, type ShellError } from 'bun';

export class GitainerServer {
  readonly bareDir: string;
  readonly repos: GitServer;
  readonly docker: DockerClient;
  readonly repoName: string;
  static readonly stackPattern: RegExp = /stacks\/([a-zA-Z-_]*)\/docker-compose\.(yaml|yml)/;
  
  bareRepo!: GitConsumer;

  private synthesisRunning: boolean = false;

  constructor(rootPath: string, docker: DockerClient) {
    this.docker = docker;
    this.bareDir = rootPath;
    this.repos = new GitServer(rootPath, {
      autoCreate: false,
    });

    this.repoName = process.env.REPO_NAME as string;

    this.repos.on('push', async (push: PushData & { log: (a?: string) => void }) => {
      console.log(`Received a push ${push.repo}/${push.commit} ( ${push.branch} )`);

      if (process.env.GIT_BRANCH !== push.branch) {
        console.error(`Gitainer only allows push on branch ( ${process.env.GIT_BRANCH} ), rejecting push`);
        push.reject(400, `Gitainer only allows push on branch ( ${process.env.GIT_BRANCH} )`);
        return;
      }

      if (this.synthesisRunning) {
        console.error("Synthesis is currently running, rejecting push");
        push.reject(409, "Synthesis in progress, please wait until it completes");
        return;
      }

      if (push.branch !== 'main') {

      }
    
      push.log();
      push.log('Thanks for pushing! Gitainer will try to synthesize your stacks defined under /stacks now');
      push.log('If it fails, the change will be reverted by the server');
      push.log('Additional pushes will be rejected until synthesis is complete or rolls back');
      push.log('In case of a rollback, container / compose changes will not be automatically resynthesized');
      push.log();
    
      push.accept();
    
      this.synthesisRunning = true;
    
      // attempt synthesis after a short delay
      setTimeout(async () => {
        await this.synthesisTime(true);
        this.synthesisRunning = false;
      }, 2000);
    });
  }

  async initRepo(): Promise<GitConsumer> {
    // create the default repo
    if (!(await this.repos.exists(this.repoName))) {
      await this.repos.create(this.repoName, (err) => err && console.log(err));
    }

    // make sure data dir exists
    await $`mkdir -p ${process.env.GITAINER_DATA}`;

    const repoDir = this.bareDir + `/${this.repoName}.git`;
    await $`echo "Gitainer Stacks" > ${repoDir}/description`;    
    // TODO: make a default readme


    this.bareRepo = new GitConsumer(repoDir);

    // change branch to main
    await this.bareRepo.repo.raw([ 'symbolic-ref', 'HEAD', 'refs/heads/main' ]);

    return this.bareRepo;
  }

  async checkForStackEnvUpdate() {
    console.log("=== start checking for env changes ===");
    let modifiedEnvs: string[] = [];

    console.log(`writing new envs to ${process.env.GITAINER_DATA}/tmpEnv`);

    await $`env > ${process.env.GITAINER_DATA}/tmpEnv`;

    // make sure this exists or the diff won't work
    await $`touch ${process.env.GITAINER_DATA}/lastSynthesizedEnv`;

    try {
      console.log(`diffing current tmpEnv to lastSynthesizedEnv`);
      const diff = await $`diff --new-line-format="%L" --old-line-format="" --unchanged-line-format="" ${process.env.GITAINER_DATA}/lastSynthesizedEnv ${process.env.GITAINER_DATA}/tmpEnv`.quiet();

      console.log("diff exit code:", diff.exitCode);
      console.log("no diff detected");
    } catch (e) {
      // for some reason this diff command exits as an error
      const output = (e as ShellError).text();
      console.log("diff exit code:", (e as ShellError).exitCode);
      console.log("diff output:");
      console.log(output);

      modifiedEnvs = output
        .split("\n")
        .slice(0, -1)
        .map(env => env.slice(0, env.indexOf("=")));

      console.log("Detected env changes", modifiedEnvs);
    }

    console.log("Checking for compose files that use these envs");

    const stacks = await this.bareRepo.listStacksWithEnvReference(modifiedEnvs);
    await this.synthesisTime(false, stacks);
  }

  async synthesisTime(shouldRevertOnFail: boolean, changes?: GitChange[]) {
    const latestChanges = changes || await this.bareRepo.getChanges("HEAD");
    let res: any = {};

    let wasSuccessful = true;
    let currentStack: string = "n/a";

    console.log(`=== Synthesis starting ===`);

  
    try {
      const stackChanges = latestChanges
      .filter(change => 
        [GitChangeType.ADD, GitChangeType.MODIFY, GitChangeType.RENAME].includes(change.type) &&
        GitainerServer.stackPattern.test(change.file)
      );
  
      if (stackChanges.length == 0) {
        console.log("Change did not contain any stack changes, so this synthesis is a noop");
      }
  
      // apply each stack change
      for (const change of stackChanges) {
        currentStack = (GitainerServer.stackPattern.exec(change.file) as RegExpExecArray)[1];
        console.log(`== stack synthesis -> ${currentStack} ==`);

        const hydratedCompose = await this.bareRepo.getStack(currentStack) as string;

        console.log(`<= ${change.file} =>`);
        console.log(hydratedCompose);

        await this.docker.composeUpdate(hydratedCompose, currentStack);
      }
  
      res = {
        msg: `Synthesis succeeded for ${stackChanges.length} stack(s)`,
        changes: stackChanges
      };
  
      console.log(res.msg);
      await $`env > ${process.env.GITAINER_DATA}/lastSynthesizedEnv`;
    } catch (e) {
      wasSuccessful = false;
      if (!shouldRevertOnFail) {
        res = {
          err: "Got an error during synthesis",
          output: (e as ShellError)?.stderr?.toString(),
        };
      } else {
        res = {
          err: "Got an error during synthesis, removing the bad commit",
          output: (e as ShellError)?.stderr?.toString(),
          failedStack: currentStack,
          latestCommit: (await this.bareRepo.repo.log({ maxCount: 1 })).latest,
        };

        // delete this commit
        await this.bareRepo.repo.reset(ResetMode.SOFT, ["HEAD^"]);
      }
    }

    console.log("=== Synthesis end ===");
    console.log(res);

    if (process.env.POST_WEBHOOK) {
      console.log(`== Sending POST to ${process.env.POST_WEBHOOK} ==`);
      await fetch(process.env.POST_WEBHOOK, {
        body: JSON.stringify(res, undefined, 2),
        method: "POST",
      });
      console.log("== Sent webhook notification ==");
    }

    return wasSuccessful;
  }

  async listen(port: number) {
    this.synthesisRunning = true;
    this.repos.listen(3000, undefined, async () => {
      console.log(await this.repos.list());
      console.log(`Gitainer running at http://localhost:${port}`);

      if (process.env.STACK_UPDATE_ON_ENV_CHANGE) {
        this.checkForStackEnvUpdate();
      }

      this.synthesisRunning = false;
    });
  }
}
