import { Git as GitServer, type PushData } from 'node-git-server';
import { GitConsumer } from './GitConsumer';
import { ResetMode } from 'simple-git';
import { GitChangeType } from './GitChange';
import type { DockerClient } from '../docker/DockerClient';


export class GitainerServer {
  readonly bareDir: string;
  readonly repos: GitServer;
  readonly docker: DockerClient;
  
  bareRepo!: GitConsumer;

  private synthesisRunning: boolean = false;

  constructor(rootPath: string, docker: DockerClient) {
    this.docker = docker;
    this.bareDir = rootPath;
    this.repos = new GitServer(rootPath, {
      autoCreate: false,
    });

    this.repos.on('push', async (push: PushData & { log: (a?: string) => void }) => {
      console.log(`Received a push ${push.repo}/${push.commit} ( ${push.branch} )`);
    
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
    
      // attempt synthesis after a short delay
      setTimeout(async () => {
        this.synthesisTime();
        this.synthesisRunning = false;
      }, 2000);
    });
  }

  async initRepo(): Promise<GitConsumer> {
    // create the default repo
    if (!(await this.repos.exists("docker"))) {
      await this.repos.create("docker", (err) => err && console.log(err));
      this.bareRepo = new GitConsumer(this.bareDir + "/docker.git");
    }

    return this.bareRepo;
  }

  listen(port: number) {
    this.repos.listen(3000, undefined, async () => {
      console.log(await this.repos.list());
      console.log(`Gitainer running at http://localhost:${port}`);
    });
  }

  async synthesisTime() {
    const latestChanges = await this.bareRepo.getChanges("HEAD");
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
        await this.docker.composeUpdate(await this.bareRepo.getFileContents(change.file) as string, stackName);
      }
  
      // TODO: notify the user somehow
  
      console.log("Synthesis succeeded for", stackChanges.length, "stack(s)");
    } catch (e: any) {
      console.error(e);
      console.log("Got an error during synthesis, removing the bad commit", await this.bareRepo.repo.log({ maxCount: 1 }));
  
      // delete this commit
      await this.bareRepo.repo.reset(ResetMode.SOFT, ["HEAD^"]);
  
      // TODO: notify the user somehow
    }
  }

}