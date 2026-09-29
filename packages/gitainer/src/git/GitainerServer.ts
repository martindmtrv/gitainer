import { Git as GitServer, type PushData } from 'node-git-server';
import { GitConsumer } from './GitConsumer';
import { ResetMode } from 'simple-git';
import { GitChangeType, type GitChange } from './GitChange';
import { isStackDisabled, type DockerClient } from '../docker/DockerClient';
import { $, type ShellError } from 'bun';
import { changedEnvKeys, readEnvSnapshot, writeEnvSnapshot } from '../server/envUtils';
import { updateProcessEnv } from '../infisical/InfisicalProvider';
import { createInitialCommitWithReadme } from './gitUtils';
import { WebhookEventType, webhookTitle } from '../webhooks/WebhookEventType';

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
  readonly selfStackName?: string;

  static readonly stackPattern: RegExp = /stacks\/([a-zA-Z-_]*)\/docker-compose\.(yaml|yml)/;

  // for renames, `file` may no longer match the stack pattern (e.g. renamed to keep for
  // historical purposes while tearing the stack down), so fall back to `oldFile`
  static resolveStackName(change: GitChange): string | undefined {
    const match = GitainerServer.stackPattern.exec(change.file)
      || (change.oldFile ? GitainerServer.stackPattern.exec(change.oldFile) : null);
    return match?.[1];
  }

  bareRepo!: GitConsumer;

  private synthesisRunning: boolean = false;
  private listening: boolean = false;

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
    selfStackName?: string,
  ) {
    this.repoName = repoName;
    this.gitBranch = gitBranch;
    this.postWebhook = postWebhook;
    this.selfStackName = selfStackName;
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
      push.log();

      push.accept();

      this.synthesisRunning = true;

      // Note: Actual synthesis will be triggered by the post-receive hook
      // calling /internal/synthesize to ensure output is piped back to the client.
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

    this.bareRepo = new GitConsumer(repoDir);

    // Create initial blank commit to ensure main branch exists if the repo is empty
    if (await this.bareRepo.isEmpty()) {
      try {
        await createInitialCommitWithReadme(repoDir, this.repoName, "main");
      } catch (e) {
        console.error("Failed to create initial commit:", e);
      }
    }

    // change branch to main
    const setMainPromise = new Promise((resolve, reject) => {
      this.bareRepo.repo.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'], (err) => {
        if (err) {
          reject(err);
        }
        resolve(null);
      });
    });

    await setMainPromise;

    return this.bareRepo;
  }

  // runs on every Infisical poll, so it stays silent unless an env actually changed
  async checkForStackEnvUpdate() {
    const currentEnv = await $`env`.text();
    writeEnvSnapshot(`${this.gitainerDataPath}/tmpEnv`, currentEnv);

    const modifiedEnvs = changedEnvKeys(
      readEnvSnapshot(`${this.gitainerDataPath}/lastSynthesizedEnv`),
      currentEnv,
    );

    if (modifiedEnvs.length === 0) {
      return;
    }

    // only log the keys, the values may be secrets (e.g. from Infisical)
    console.log("Detected env changes", modifiedEnvs);

    console.log("Checking for compose files that use these envs");

    const stacks = await this.bareRepo.listStacksWithEnvReference(modifiedEnvs);
    if (stacks.length > 0) {
      const { pendingSelfUpdateTriggers } = await this.synthesisTime(false, WebhookEventType.ENV_UPDATE, stacks);
      for (const trigger of pendingSelfUpdateTriggers) {
        await trigger();
      }
    } else {
      // nothing to synthesize, so record these envs as handled or the same diff is reported on every check
      console.log("No stacks use the changed envs, updating lastSynthesizedEnv");
      writeEnvSnapshot(`${this.gitainerDataPath}/lastSynthesizedEnv`, currentEnv);
    }
  }

  // a check that fails (e.g. an unreachable remote host) counts as deployed, so the synthesis
  // goes ahead and reports the real error instead of silently skipping the stack
  private async isIndirectStackDeployed(stackName: string, log: (msg: string) => void): Promise<boolean> {
    try {
      return await this.docker.isComposeStackDeployed(await this.bareRepo.getStack(stackName) as string, stackName);
    } catch (e) {
      log(`Could not check whether ${stackName} is deployed, redeploying it: ${e}`);
      return true;
    }
  }

  isSelfStack(stackName: string): boolean {
    return !!this.selfStackName && stackName === this.selfStackName;
  }

  async synthesisTime(shouldRevertOnFail: boolean, event: WebhookEventType, changes?: GitChange[], logger?: (msg: string) => void, oldrev?: string) {
    const log = (msg: string) => {
      console.log(msg);
      if (logger) logger(msg);
    };

    const latestChanges = changes || await this.bareRepo.getChangesForPush(oldrev, "HEAD");
    let res: any = {};

    let wasSuccessful = true;
    let currentStack: string = "n/a";
    let hydratedCompose: string = 'n/a';

    log(`=== Synthesis starting ===`);

    const fragmentChanges = latestChanges
      .filter(change => change.file.startsWith(this.fragmentsPath + "/"));

    const fragmentStackChanges = await this.bareRepo.listStacksWithEnvReference([], fragmentChanges.map(fragment => fragment.file));

    const stackChanges = latestChanges
      .filter(change =>
        ([GitChangeType.ADD, GitChangeType.MODIFY, GitChangeType.RENAME, GitChangeType.DELETE].includes(change.type) ||
          change.type.toString().startsWith("R")) &&
        (GitainerServer.stackPattern.test(change.file) ||
          (change.oldFile !== undefined && GitainerServer.stackPattern.test(change.oldFile)))
      );

    // deduplicate based on file
    const uniqueChangesMap = new Map<string, GitChange>();
    [...stackChanges, ...fragmentStackChanges].forEach(change => {
      // we only want one entry per file
      if (!uniqueChangesMap.has(change.file)) {
        uniqueChangesMap.set(change.file, change);
      }
    });

    // a stack that isn't deployed (downed through the API or by hand) isn't brought back up by
    // an env or fragment change - only by a change to its own compose file, or an explicit
    // up/restart/reload. A stack changed directly and via a fragment is kept as a direct change
    // by the dedup above.
    const skippedStacks: string[] = [];
    const allStackChanges: GitChange[] = [];
    for (const change of uniqueChangesMap.values()) {
      const stackName = GitainerServer.resolveStackName(change) as string;
      if (change.indirect && !this.isSelfStack(stackName) && !(await this.isIndirectStackDeployed(stackName, log))) {
        log(`== skipping ${stackName}: not deployed, so not redeploying it (${change.reason}) ==`);
        skippedStacks.push(stackName);
        continue;
      }
      allStackChanges.push(change);
    }
    const skippedMsg = skippedStacks.length ? `. Skipped ${skippedStacks.length} stack(s) that aren't deployed: ${skippedStacks.join(', ')}` : '';
    // process the self stack last, so any other stacks in this push get their fully
    // reversible update+rollback before the irreversible self-update is triggered
    const combinedStackChanges = this.selfStackName
      ? [
          ...allStackChanges.filter(change => !this.isSelfStack(GitainerServer.resolveStackName(change) as string)),
          ...allStackChanges.filter(change => this.isSelfStack(GitainerServer.resolveStackName(change) as string)),
        ]
      : allStackChanges;
    const successfullyProcessedStacks: { file: string, stackName: string, content: string }[] = [];
    const selfStackWarnings: string[] = [];
    const disabledStacks: string[] = [];
    const pendingSelfUpdateTriggers: (() => Promise<void>)[] = [];

    try {
      if (combinedStackChanges.length == 0) {
        log("Change did not contain any stack changes, so this synthesis is a noop");
      }

      // pull every stack's images before touching any stack, so a bad image (a typo, the
      // registry being down) fails the synthesis before anything is torn down, and the pulls
      // don't overlap the container churn (and reverse proxy reloads) of the deploys below
      for (const change of combinedStackChanges) {
        currentStack = change.file;
        const stackName = GitainerServer.stackPattern.exec(change.file)?.[1];
        // deletes and renames out of the stack pattern deploy nothing. The self stack is pulled
        // here too, so a bad gitainer image also fails before any other stack is touched
        if (change.type === GitChangeType.DELETE || !stackName) {
          continue;
        }

        hydratedCompose = await this.bareRepo.getStack(stackName) as string;
        // also validates the flag, so a bad value fails before any stack is touched
        if (isStackDisabled(hydratedCompose)) {
          continue;
        }
        log(`Pulling images for ${stackName}`);
        await this.docker.composePull(hydratedCompose, stackName);
      }

      // apply each stack change
      for (const change of combinedStackChanges) {
        currentStack = change.file;
        const isRename = change.type.toString().startsWith("R");
        const newStackName = GitainerServer.stackPattern.exec(change.file)?.[1];
        const oldStackName = change.oldFile ? GitainerServer.stackPattern.exec(change.oldFile)?.[1] : undefined;
        const stackName = (newStackName ?? oldStackName) as string;
        // a rename that moves the compose file out of the stack pattern (e.g. renamed to keep
        // it in the repo for historical purposes) should only tear the stack down, not re-deploy it
        const renamedOutOfStack = isRename && !newStackName && !!oldStackName;
        log(`== stack synthesis -> ${stackName} (type: ${change.type}) ==`);

        // x-gitainer-disabled: true keeps the stack down, like a delete that leaves it in the repo
        const hasNewVersion = change.type !== GitChangeType.DELETE && !renamedOutOfStack;
        const disabled = hasNewVersion && isStackDisabled(await this.bareRepo.getStack(stackName) as string);

        if (this.isSelfStack(stackName)) {
          if (disabled) {
            const warning = `Refusing to disable self-stack "${stackName}" (x-gitainer-disabled): the running gitainer container was left untouched.`;
            log(warning);
            selfStackWarnings.push(warning);
            continue;
          }
          if (change.type === GitChangeType.DELETE || renamedOutOfStack) {
            const warning = `Refusing to ${renamedOutOfStack ? 'tear down' : 'delete'} self-stack "${stackName}": the running gitainer container was left untouched. Remove it manually via docker if this was intentional.`;
            log(warning);
            selfStackWarnings.push(warning);
            continue;
          }

          hydratedCompose = await this.bareRepo.getStack(stackName) as string;

          log(`<= ${change.file} (self-update) =>`);
          // We don't log the full compose file to the git client as it can be very long
          console.log(hydratedCompose);

          // Prepare (validate/pull/stage) now, but defer actually triggering the recreate: it
          // can end with this very process being replaced, and doing that while the HTTP
          // response for this push is still in flight would abort it client-side even though
          // the update succeeded. The caller runs pendingSelfUpdateTriggers after the response
          // is fully sent.
          pendingSelfUpdateTriggers.push(await this.docker.prepareSelfUpdate(hydratedCompose, stackName, false));
          continue;
        }

        if (change.type === GitChangeType.DELETE || change.type === GitChangeType.MODIFY || isRename) {
          const cleanUpTarget = (oldrev && !/^0+$/.test(oldrev)) ? oldrev : "HEAD^";
          const oldContent = await this.bareRepo.getStack(stackName, cleanUpTarget);
          // renaming a compose file to no longer match the stack pattern (e.g. prefixing it to
          // keep it around for historical purposes) tears the stack down without redeploying it
          const willRedeploy = hasNewVersion && !disabled;

          if (hasNewVersion) {
            // images were already pulled above, so there's no pull-induced downtime between
            // down() and up()
            hydratedCompose = await this.bareRepo.getStack(stackName) as string;
          }

          if (oldContent) {
            log(`Deconfiguring ${stackName} (deleted, renamed, modified or disabled)`);
            // run the newest version's shutdown hook: the incoming one when there is one, so a
            // push can fix a broken hook instead of being blocked by it
            await this.docker.composeDown(oldContent, stackName, hasNewVersion ? hydratedCompose : oldContent, log);
          }
          if (disabled) {
            log(`== ${stackName} has x-gitainer-disabled: true, not deploying it ==`);
            disabledStacks.push(stackName);
          }
          if (!willRedeploy) {
            continue;
          }
        } else {
          hydratedCompose = await this.bareRepo.getStack(stackName) as string;
          if (disabled) {
            log(`== ${stackName} has x-gitainer-disabled: true, not deploying it ==`);
            disabledStacks.push(stackName);
            continue;
          }
        }

        log(`<= ${change.file} =>`);
        // We don't log the full compose file to the git client as it can be very long
        console.log(hydratedCompose);

        await this.docker.composeUpdate(hydratedCompose, stackName, false);
        successfullyProcessedStacks.push({
          file: change.file,
          stackName,
          content: hydratedCompose
        });
      }

      const changedStackNames = combinedStackChanges.map(change => change.file).join(', ');
      res = {
        msg: `Synthesis succeeded for ${combinedStackChanges.length} stack(s)${changedStackNames ? `: ${changedStackNames}` : ''}${disabledStacks.length ? `. Disabled with x-gitainer-disabled (not deployed): ${disabledStacks.join(', ')}` : ''}${skippedMsg}`,
        changes: combinedStackChanges,
        ...(disabledStacks.length ? { disabledStacks } : {}),
        ...(skippedStacks.length ? { skippedStacks } : {}),
        ...(selfStackWarnings.length ? { warnings: selfStackWarnings } : {}),
      };

      log(res.msg);
      writeEnvSnapshot(`${this.gitainerDataPath}/lastSynthesizedEnv`, await $`env`.text());
    } catch (e) {
      const errMsg = (e as Error).hasOwnProperty('message') ? (e as Error).message : String(e);
      log(errMsg);
      wasSuccessful = false;
      res = {
        output: (e as ShellError)?.stderr?.toString() || errMsg,
        failedStackContent: hydratedCompose,
        ...(skippedStacks.length ? { skippedStacks } : {}),
      };
      if (!shouldRevertOnFail) {
        res = {
          ...res,
          err: `Got an error during synthesis of stack "${currentStack}": ${res.output}${skippedMsg}`,
        };
      } else {
        const succeededStacks = combinedStackChanges.length === 0 || currentStack === combinedStackChanges[0].file ? [] :
          combinedStackChanges
            .slice(
              0,
              combinedStackChanges.findIndex(change => change.file === currentStack)
            ).map(stack => stack.file);
        res = {
          ...res,
          err: `Got an error during synthesis of stack "${currentStack}", removing the bad commit. Succeeded stacks (not rolled back): ${succeededStacks.length ? succeededStacks.join(', ') : 'none'}. Error: ${res.output}${skippedMsg}`,
          suceededStacks: succeededStacks,
          failedStack: currentStack,
          latestCommit: (await this.bareRepo.repo.log({ maxCount: 1 })).latest,
        };
        log(res.err);

        // Rollback successful stacks
        log(`Rolling back successful stacks: ${successfullyProcessedStacks.map(s => s.stackName).join(', ')}`);
        for (const stack of successfullyProcessedStacks) {
          try {
            log(`Rolling back (down) ${stack.stackName} with new content`);
            await this.docker.composeDown(stack.content, stack.stackName, stack.content, log);
          } catch (rollbackError) {
            log(`Failed to down stack ${stack.stackName}: ${rollbackError}`);
          }
        }

        // delete this commit
        const rollbackTarget = (oldrev && !/^0+$/.test(oldrev)) ? oldrev : "HEAD^";
        await this.bareRepo.repo.reset(ResetMode.SOFT, [rollbackTarget]);

        // Restore successful stacks to previous state
        for (const stack of successfullyProcessedStacks) {
          try {
            const oldContent = await this.bareRepo.getStack(stack.stackName, "HEAD");
            if (oldContent) {
              log(`Restoring ${stack.stackName} to previous state`);
              await this.docker.composeUpdate(oldContent, stack.stackName);
            } else {
              log(`Stack ${stack.stackName} did not exist in previous state, leaving it down`);
            }
          } catch (restoreError) {
            log(`Failed to restore stack ${stack.stackName}: ${restoreError}`);
          }
        }
      }
    }

    log("=== Synthesis end ===");
    res.title = webhookTitle(event);
    console.log(res);

    if (this.postWebhook) {
      log(`== Sending POST to ${this.postWebhook} ==`);
      await fetch(this.postWebhook, {
        body: JSON.stringify(res),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }).catch(err => log(err));
      log("== Sent webhook notification ==");
    }

    // push all the current stack files to a dir
    await this.bareRepo.writeAllStacksToDir(this.stacksPath);

    return { wasSuccessful, pendingSelfUpdateTriggers };
  }

  async listen(port: number) {
    const repoDir = this.bareDir + `/${this.repoName}.git`;
    const hookPath = `${repoDir}/hooks/post-receive`;
    const hookContent = `#!/bin/bash
# Gitainer post-receive hook
while read oldrev newrev refname
do
  if [ "$refname" = "refs/heads/${this.gitBranch}" ]; then
    echo "remote: Gitainer: Starting synthesis..."
    curl -s -X POST "http://localhost:${port}/internal/synthesize?commit=$newrev&oldrev=$oldrev"
  fi
done
`;
    await $`echo ${hookContent} > ${hookPath}`;
    await $`chmod +x ${hookPath}`;

    const originalHandle = this.repos.handle.bind(this.repos);
    this.repos.handle = (req: any, res: any) => {
      if (req.method === 'POST' && req.url.includes('/internal/synthesize')) {
        const url = new URL(req.url, `http://localhost:${port}`);
        const oldrev = url.searchParams.get('oldrev') || undefined;
        (async () => {
          try {
            // update process env on synthesis
            await updateProcessEnv();
            const { pendingSelfUpdateTriggers } = await this.synthesisTime(true, WebhookEventType.GIT_PUSH, undefined, (msg) => {
              res.write(msg + "\n");
            }, oldrev);

            if (pendingSelfUpdateTriggers.length > 0) {
              // Keep rejecting pushes until the self-update has actually been triggered, so a
              // push arriving before then can't race the recreate (e.g. get synthesized
              // against a container that's about to be replaced out from under it).
              //
              // Wait for Node's 'finish' event (this response's bytes have actually been
              // handed to the OS socket) rather than a blind delay - it's the closest signal
              // available, from inside this process, that the post-receive hook's curl (and
              // thus `git receive-pack` reporting success) has what it needs, before the
              // recreate potentially kills this very process - see prepareSelfUpdate() for why
              // this can't just run inline before res.end(). 'close' is a fallback in case the
              // connection drops before 'finish' fires, so this can't hang forever.
              let fired = false;
              const runTriggers = () => {
                if (fired) return;
                fired = true;
                Promise.allSettled(pendingSelfUpdateTriggers.map(trigger => trigger()))
                  .then(results => {
                    for (const result of results) {
                      if (result.status === "rejected") {
                        console.error("Self-update trigger failed:", result.reason);
                      }
                    }
                  })
                  .finally(() => {
                    this.synthesisRunning = false;
                  });
              };
              res.once("finish", runTriggers);
              res.once("close", runTriggers);
              res.end();
            } else {
              res.end();
              this.synthesisRunning = false;
            }
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
            this.synthesisRunning = false;
          }
        })();
        return;
      }

      originalHandle(req, res);
    };

    this.repos.listen(port, undefined, () => {
      this.listening = true;
      console.log(`Gitainer running at http://localhost:${port}`);

      if (this.stackUpdateOnEnvChange) {
        this.checkForStackEnvUpdate();
      }
    });
  }

  async close() {
    this.repos.removeAllListeners();
    if (this.listening) {
      await this.repos.close();
      this.listening = false;
    }
  }
}
