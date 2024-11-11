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
  readonly gitBranch: string;
  readonly gitainerDataPath: string;
  readonly fragmentsPath: string;
  readonly stacksPath: string;
  readonly stackUpdateOnEnvChange: boolean;
  readonly postWebhook?: string;

  static readonly stackPattern: RegExp = /stacks\/([a-zA-Z-_]*)\/docker-compose\.(yaml|yml)/;
  
  bareRepo!: GitConsumer;

  private synthesisRunning: boolean = false;

  constructor(
    repoName: string,
    gitBranch: string,
    repoDir: string, 
    gitainerDataPath: string,
    fragmentsPath: string,
    stacksPath: string,
    docker: DockerClient,
    stackUpdateOnEnvChange: boolean = true,
    postWebhook?: string,
  ) {
    this.repoName = repoName;
    this.gitBranch = gitBranch;
    this.postWebhook = postWebhook;
    this.gitainerDataPath = gitainerDataPath;
    this.stackUpdateOnEnvChange = stackUpdateOnEnvChange;
    this.fragmentsPath = fragmentsPath;
    this.stacksPath = stacksPath;

    this.docker = docker;
    this.bareDir = repoDir;
    this.repos = new GitServer(repoDir, {
      autoCreate: false,
    });

    this.repos.on('push', async (push: PushData & { log: (a?: string) => void }) => {
      console.log(`Received a push ${push.repo}/${push.commit} ( ${push.branch} )`);

      if (this.gitBranch !== push.branch) {
        console.error(`Gitainer only allows push on branch ( ${this.gitBranch} ), rejecting push`);
        push.reject(400, `Gitainer only allows push on branch ( ${this.gitBranch} )`);
        return;
      }

      if (this.synthesisRunning) {
        console.error("Synthesis is currently running, rejecting push");
        push.reject(409, "Synthesis in progress, please wait until it completes");
        return;
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
    let repoCreate: Promise<void> | undefined = undefined;

    // create the default repo
    if (!this.repos.exists(this.repoName)) {
      repoCreate = new Promise((resolve, reject) => {
        this.repos.create(this.repoName, (err) => {
          if (err) {
            reject(err);
          }
          resolve();
        });
      })
    }

    // await creation
    if (repoCreate) {
      await repoCreate;
    }

    // make sure data dir exists
    await $`mkdir -p ${this.gitainerDataPath}`;

    const repoDir = this.bareDir + `/${this.repoName}.git`;
    await $`echo "Gitainer Stacks" > ${repoDir}/description`;
    // TODO: make a default readme
    this.bareRepo = new GitConsumer(repoDir);

    // change branch to main
    const setMainPromise = new Promise((resolve, reject) => {
      this.bareRepo.repo.raw([ 'symbolic-ref', 'HEAD', 'refs/heads/main' ], (err) => {
        if (err) {
          reject(err);
        }
        resolve(null);
      });
    });

    await setMainPromise;

    return this.bareRepo;
  }

  async checkForStackEnvUpdate() {
    console.log("=== start checking for env changes ===");
    let modifiedEnvs: string[] = [];

    console.log(`writing new envs to ${this.gitainerDataPath}/tmpEnv`);

    await $`env > ${this.gitainerDataPath}/tmpEnv`;

    // make sure this exists or the diff won't work
    await $`touch ${this.gitainerDataPath}/lastSynthesizedEnv`;

    try {
      console.log(`diffing current tmpEnv to lastSynthesizedEnv`);
      const diff = await $`diff --new-line-format="%L" --old-line-format="" --unchanged-line-format="" ${this.gitainerDataPath}/lastSynthesizedEnv ${this.gitainerDataPath}/tmpEnv`.quiet();

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
    let hydratedCompose: string = 'n/a';

    console.log(`=== Synthesis starting ===`);

    const fragmentChanges = latestChanges
      .filter(change => change.file.startsWith(this.fragmentsPath + "/"));

    const fragmentStackChanges = await this.bareRepo.listStacksWithEnvReference([], fragmentChanges.map(fragment => fragment.file));

    const stackChanges = latestChanges
      .filter(change => 
        [GitChangeType.ADD, GitChangeType.MODIFY, GitChangeType.RENAME].includes(change.type) &&
        GitainerServer.stackPattern.test(change.file)
      );

    stackChanges.push(...fragmentStackChanges);
  
    try {
      if (stackChanges.length == 0) {
        console.log("Change did not contain any stack changes, so this synthesis is a noop");
      }
  
      // apply each stack change
      for (const change of stackChanges) {
        currentStack = change.file;
        const stackName = (GitainerServer.stackPattern.exec(change.file) as RegExpExecArray)[1];
        console.log(`== stack synthesis -> ${stackName} ==`);

        hydratedCompose = await this.bareRepo.getStack(stackName) as string;

        console.log(`<= ${change.file} =>`);
        console.log(hydratedCompose);

        await this.docker.composeUpdate(hydratedCompose, stackName);
      }
  
      res = {
        msg: `Synthesis succeeded for ${stackChanges.length} stack(s)`,
        changes: stackChanges
      };
  
      console.log(res.msg);
      await $`env > ${this.gitainerDataPath}/lastSynthesizedEnv`;
    } catch (e) {
      console.error(e);
      wasSuccessful = false;
      res = {
        output: (e as ShellError)?.stderr?.toString() || (e as Error).message,
        failedStackContent: hydratedCompose,
      };
      if (!shouldRevertOnFail) {
        res = {
          ...res,
          err: "Got an error during synthesis",
        };
      } else {
        res = {
          ...res,
          err: "Got an error during synthesis, removing the bad commit. Succeeded stacks will not be rolled back",
          suceededStacks: stackChanges.length === 0 || currentStack === stackChanges[0].file ? []: 
            stackChanges
              .slice(
                0, 
                stackChanges.findIndex(change => change.file === currentStack)
              ).map(stack => stack.file),
          failedStack: currentStack,
          latestCommit: (await this.bareRepo.repo.log({ maxCount: 1 })).latest,
        };

        // delete this commit
        await this.bareRepo.repo.reset(ResetMode.SOFT, ["HEAD^"]);
      }
    }

    console.log("=== Synthesis end ===");
    console.log(res);

    if (this.postWebhook) {
      console.log(`== Sending POST to ${this.postWebhook} ==`);
      await fetch(this.postWebhook, {
        body: JSON.stringify(res, undefined, 2),
        method: "POST",
      });
      console.log("== Sent webhook notification ==");
    }

    // push all the current stack files to a dir
    await this.bareRepo.writeAllStacksToDir(this.stacksPath);

    return wasSuccessful;
  }

  async listen(port: number) {
    this.synthesisRunning = true;
    this.repos.listen(3000, undefined, async () => {
      console.log(await this.repos.list());
      console.log(`Gitainer running at http://localhost:${port}`);

      if (this.stackUpdateOnEnvChange) {
        this.checkForStackEnvUpdate();
      }

      this.synthesisRunning = false;
    });
  }

  async close() {
    this.repos.removeAllListeners();
    await this.repos.close();
  }
}
