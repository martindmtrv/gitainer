import { expect, test, describe, afterEach } from "bun:test";
import { WebhookServer } from "../src/webhooks/WebhookServer";
import { EventStore } from "../src/store/EventStore";

describe("WebhookServer API Key Authentication", () => {
  const mockDocker = {} as any;
  const mockBareRepo = {
    getStack: async (name: string) => {
      if (name === "existing") {
        return "version: '3'\nservices:\n  app:\n    image: nginx";
      }
      return null;
    }
  } as any;
  const mockGitainer = {
    postWebhook: undefined
  } as any;

  afterEach(() => {
    delete process.env.GITAINER_API_KEY;
    delete process.env.WEBHOOK_API_KEY;
  });

  test("no API key set allows access", async () => {
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);
    const res = await server.app.request("/api/stacks/existing");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("version: '3'\nservices:\n  app:\n    image: nginx");
  });

  test("GITAINER_API_KEY set blocks request without key", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);
    
    const res = await server.app.request("/api/stacks/existing");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ err: "Unauthorized" });
  });

  test("GITAINER_API_KEY set blocks request with wrong key", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);
    
    const res = await server.app.request("/api/stacks/existing", {
      headers: {
        "X-API-Key": "wrong-secret",
      },
    });
    expect(res.status).toBe(401);
  });

  test("GITAINER_API_KEY set allows request with correct Bearer token", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);
    
    const res = await server.app.request("/api/stacks/existing", {
      headers: {
        "Authorization": "Bearer test-secret",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("version: '3'\nservices:\n  app:\n    image: nginx");
  });

  test("GITAINER_API_KEY set allows request with correct raw Authorization header", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);
    
    const res = await server.app.request("/api/stacks/existing", {
      headers: {
        "Authorization": "test-secret",
      },
    });
    expect(res.status).toBe(200);
  });

  test("GITAINER_API_KEY set allows request with correct X-API-Key header", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);
    
    const res = await server.app.request("/api/stacks/existing", {
      headers: {
        "X-API-Key": "test-secret",
      },
    });
    expect(res.status).toBe(200);
  });

  test("WEBHOOK_API_KEY set allows request with correct x-api-key header", async () => {
    process.env.WEBHOOK_API_KEY = "another-secret";
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/existing", {
      headers: {
        "x-api-key": "another-secret",
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("WebhookServer force stack update", () => {
  const mockBareRepo = {
    getStack: async (name: string) => {
      if (name === "existing") {
        return "version: '3'\nservices:\n  app:\n    image: nginx";
      }
      return null;
    }
  } as any;
  const mockGitainer = {
    postWebhook: undefined,
    isSelfStack: () => false,
  } as any;

  test("POST /api/stacks/:stackName pulls images before tearing the stack down", async () => {
    const calls: string[] = [];
    const mockDocker = {
      composePull: async (composeString: string, stackName: string) => {
        calls.push(`composePull:${stackName}`);
      },
      composeDown: async (composeString: string, stackName: string) => {
        calls.push(`composeDown:${stackName}`);
      },
      composeUpdate: async (composeString: string, stackName: string) => {
        calls.push(`composeUpdate:${stackName}`);
        return { text: () => "updated" };
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/existing", { method: "POST" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      "composePull:existing",
      "composeDown:existing",
      "composeUpdate:existing",
    ]);
  });

  test("POST /api/stacks/:stackName returns 404 for unknown stack", async () => {
    const mockDocker = {} as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/nope", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("WebhookServer stack down/up/restart", () => {
  const mockBareRepo = {
    getStack: async (name: string) => {
      if (name === "existing" || name === "gitainer") {
        return "version: '3'\nservices:\n  app:\n    image: nginx";
      }
      return null;
    }
  } as any;
  const mockGitainer = {
    postWebhook: undefined,
    isSelfStack: (name: string) => name === "gitainer",
  } as any;

  function recordingDocker(calls: string[]) {
    return {
      composePull: async (composeString: string, stackName: string) => {
        calls.push(`composePull:${stackName}`);
      },
      composeDown: async (composeString: string, stackName: string) => {
        calls.push(`composeDown:${stackName}`);
        return { text: () => "downed" };
      },
      composeUp: async (composeString: string, stackName: string) => {
        calls.push(`composeUp:${stackName}`);
        return { text: () => "up" };
      },
      composeUpdate: async (composeString: string, stackName: string, pull: boolean) => {
        calls.push(`composeUpdate:${stackName}:pull=${pull}`);
        return { text: () => "recreated" };
      },
    } as any;
  }

  test("POST /api/stacks/:stackName/down downs the stack without pulling or starting it", async () => {
    const calls: string[] = [];
    const server = new WebhookServer(recordingDocker(calls), mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/existing/down", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "Gitainer: Webhook",
      stackName: "existing",
      msg: "Successfully downed stack existing: downed",
      output: "downed",
    });
    expect(calls).toEqual(["composeDown:existing"]);
  });

  test("POST /api/stacks/:stackName/up starts the stack without a down or pull", async () => {
    const calls: string[] = [];
    const server = new WebhookServer(recordingDocker(calls), mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/existing/up", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).msg).toBe("Successfully started stack existing: up");
    expect(calls).toEqual(["composeUp:existing"]);
  });

  test("POST /api/stacks/:stackName/restart downs and recreates the stack without pulling", async () => {
    const calls: string[] = [];
    const server = new WebhookServer(recordingDocker(calls), mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/existing/restart", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).msg).toBe("Successfully restarted stack existing: recreated");
    expect(calls).toEqual(["composeDown:existing", "composeUpdate:existing:pull=false"]);
  });

  test("notifies POST_WEBHOOK on success", async () => {
    const received: any[] = [];
    const hook = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push(await req.json());
        return new Response("ok");
      },
    });

    try {
      const gitainer = { ...mockGitainer, postWebhook: `http://localhost:${hook.port}/` };
      const server = new WebhookServer(recordingDocker([]), mockBareRepo, gitainer);

      const res = await server.app.request("/api/stacks/existing/down", { method: "POST" });
      expect(res.status).toBe(200);
      expect(received).toEqual([{
        title: "Gitainer: Webhook",
        stackName: "existing",
        msg: "Successfully downed stack existing: downed",
        output: "downed",
      }]);
    } finally {
      hook.stop(true);
    }
  });

  test("a failure responds with a 400", async () => {
    const mockDocker = {
      composeDown: async () => {
        throw new Error("shutdown hook failed");
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/existing/down", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ err: "shutdown hook failed" });
  });

  test("a slow action streams keepalives, then the result", async () => {
    const mockDocker = {
      composeUp: async () => {
        await Bun.sleep(250);
        return { text: () => "up" };
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer, 50);

    const res = await server.app.request("/api/stacks/existing/up", { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toStartWith("\n\n");
    expect(JSON.parse(text).msg).toBe("Successfully started stack existing: up");
  });

  test.each(["down", "up", "restart"])("POST /api/stacks/:stackName/%s returns 404 for unknown stack", async (action) => {
    const calls: string[] = [];
    const server = new WebhookServer(recordingDocker(calls), mockBareRepo, mockGitainer);

    const res = await server.app.request(`/api/stacks/nope/${action}`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ err: "Unknown stack nope" });
    expect(calls).toEqual([]);
  });

  test.each(["down", "up", "restart"])("POST /api/stacks/:stackName/%s refuses gitainer's own stack", async (action) => {
    const calls: string[] = [];
    const server = new WebhookServer(recordingDocker(calls), mockBareRepo, mockGitainer);

    const res = await server.app.request(`/api/stacks/gitainer/${action}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).err).toBe(`Can't ${action} gitainer's own stack gitainer; use POST /api/stacks/gitainer to update it`);
    expect(calls).toEqual([]);
  });
});

describe("WebhookServer x-gitainer-disabled stacks", () => {
  const stacks: Record<string, string> = {
    disabled: "x-gitainer-disabled: true\nservices:\n  app:\n    image: nginx",
    commented: "# x-gitainer-disabled: true\nservices:\n  app:\n    image: nginx",
    fromEnv: "x-gitainer-disabled: ${GITAINER_WEBHOOK_TEST_DISABLED:-false}\nservices:\n  app:\n    image: nginx",
  };
  const mockBareRepo = {
    getStack: async (name: string) => stacks[name] ?? null,
  } as any;
  const mockGitainer = {
    postWebhook: undefined,
    isSelfStack: () => false,
  } as any;
  const mockDocker = {
    composePull: async () => {},
    composeDown: async () => ({ text: () => "downed" }),
    composeUp: async () => ({ text: () => "up" }),
    composeUpdate: async () => ({ text: () => "recreated" }),
  } as any;

  test.each(["", "/up", "/restart"])("POST /api/stacks/:stackName%s refuses a disabled stack", async (suffix) => {
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request(`/api/stacks/disabled${suffix}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ err: "Stack disabled is disabled with x-gitainer-disabled: true; remove the flag in git (or unset the env var it reads) to deploy it" });
  });

  test("POST /api/stacks/:stackName/down still downs a disabled stack", async () => {
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/disabled/down", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test.each(["", "/up", "/restart"])("POST /api/stacks/:stackName%s uses the interpolated value of a flag set from an env var", async (suffix) => {
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    try {
      process.env.GITAINER_WEBHOOK_TEST_DISABLED = "true";
      const refused = await server.app.request(`/api/stacks/fromEnv${suffix}`, { method: "POST" });
      expect(refused.status).toBe(400);
      expect((await refused.json()).err).toStartWith("Stack fromEnv is disabled with x-gitainer-disabled: true");

      process.env.GITAINER_WEBHOOK_TEST_DISABLED = "false";
      expect((await server.app.request(`/api/stacks/fromEnv${suffix}`, { method: "POST" })).status).toBe(200);

      // unset, so the default applies
      delete process.env.GITAINER_WEBHOOK_TEST_DISABLED;
      expect((await server.app.request(`/api/stacks/fromEnv${suffix}`, { method: "POST" })).status).toBe(200);
    } finally {
      delete process.env.GITAINER_WEBHOOK_TEST_DISABLED;
    }
  });

  test.each(["", "/up", "/restart"])("POST /api/stacks/:stackName%s ignores a commented-out flag", async (suffix) => {
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request(`/api/stacks/commented${suffix}`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("WebhookServer keepalive for long stack updates", () => {
  const mockBareRepo = {
    getStack: async () => "version: '3'\nservices:\n  app:\n    image: nginx",
  } as any;
  const mockGitainer = {
    postWebhook: undefined,
    isSelfStack: () => false,
  } as any;

  function mockDocker(updateMs: number, fail = false) {
    return {
      composePull: async () => {},
      composeDown: async () => {},
      composeUpdate: async () => {
        await Bun.sleep(updateMs);
        if (fail) {
          throw new Error("compose up failed");
        }
        return { text: () => "updated" };
      },
    } as any;
  }

  test("a fast failure still responds with a 400", async () => {
    const server = new WebhookServer(mockDocker(0, true), mockBareRepo, mockGitainer, 1000);

    const res = await server.app.request("/api/stacks/existing", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).err).toBe("compose up failed");
  });

  test("a slow update streams whitespace, then the result", async () => {
    const server = new WebhookServer(mockDocker(250), mockBareRepo, mockGitainer, 50);

    const res = await server.app.request("/api/stacks/existing?pretty", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("application/json");
    const text = await res.text();
    expect(text).toStartWith("\n\n");
    expect(text).toContain('\n  "stackName": "existing"');
    expect(JSON.parse(text).msg).toBe("Successfully updated stack existing: updated");
  });

  test("a slow failure responds with a 200 and reports it in err", async () => {
    const server = new WebhookServer(mockDocker(250, true), mockBareRepo, mockGitainer, 50);

    const res = await server.app.request("/api/stacks/existing", { method: "POST" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ err: "compose up failed" });
  });

  test("keepalives hold the connection open past the server's idleTimeout", async () => {
    // without keepalives Bun drops this request with an empty reply after ~8s. Bun checks
    // timeouts in 4s ticks and closes after 4s for any idleTimeout <= 4, even while the
    // response is being written, so 5s is the shortest one keepalives can hold open.
    const server = new WebhookServer(mockDocker(12_000), mockBareRepo, mockGitainer, 1500);
    const httpServer = Bun.serve({ idleTimeout: 5, fetch: server.app.fetch, port: 0 });

    try {
      const res = await fetch(`http://localhost:${httpServer.port}/api/stacks/existing?pretty`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(JSON.parse(await res.text()).stackName).toBe("existing");
    } finally {
      httpServer.stop(true);
    }
  }, { timeout: 20_000 });
});

describe("WebhookServer bulk stop/start by label", () => {
  const mockBareRepo = {} as any;
  const mockGitainer = {
    postWebhook: undefined
  } as any;

  test("POST /api/labels/:identifier/stop stops matching containers", async () => {
    const mockDocker = {
      stopContainersByLabel: async (identifier: string) => {
        expect(identifier).toBe("myapp");
        return ["abc123", "def456"];
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/labels/myapp/stop", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      title: "Gitainer: Webhook",
      identifier: "myapp",
      msg: "Stopped 2 container(s) labelled gitainer.identifier=myapp",
      containerIds: ["abc123", "def456"],
    });
  });

  test("POST /api/labels/:identifier/start starts matching containers", async () => {
    const mockDocker = {
      startContainersByLabel: async (identifier: string) => {
        expect(identifier).toBe("myapp");
        return ["abc123"];
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/labels/myapp/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      title: "Gitainer: Webhook",
      identifier: "myapp",
      msg: "Started 1 container(s) labelled gitainer.identifier=myapp",
      containerIds: ["abc123"],
    });
  });

  test("POST /api/labels/:identifier/stop returns 400 on docker error", async () => {
    const mockDocker = {
      stopContainersByLabel: async () => {
        throw new Error("docker daemon unreachable");
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/labels/myapp/stop", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ err: "docker daemon unreachable" });
  });
});

describe("WebhookServer registry cleanup", () => {
  const mockBareRepo = {} as any;
  const mockGitainer = {
    postWebhook: undefined
  } as any;

  test("POST /api/registry/:containerName/cleanup runs garbage-collect", async () => {
    const mockDocker = {
      registryGarbageCollect: async (containerName: string, deleteUntagged: boolean, configPath?: string) => {
        expect(containerName).toBe("registry");
        expect(deleteUntagged).toBe(false);
        expect(configPath).toBeUndefined();
        return "blob eligible for deletion: ...";
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/registry/registry/cleanup", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      title: "Gitainer: Webhook",
      containerName: "registry",
      msg: "Ran registry garbage-collect on registry",
      output: "blob eligible for deletion: ...",
    });
  });

  test("POST /api/registry/:containerName/cleanup?deleteUntagged=true forwards flag", async () => {
    const mockDocker = {
      registryGarbageCollect: async (containerName: string, deleteUntagged: boolean) => {
        expect(deleteUntagged).toBe(true);
        return "";
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/registry/registry/cleanup?deleteUntagged=true", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("POST /api/registry/:containerName/cleanup returns 400 on docker error", async () => {
    const mockDocker = {
      registryGarbageCollect: async () => {
        throw new Error("container not found");
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/registry/registry/cleanup", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ err: "container not found" });
  });
});

describe("WebhookServer named commands", () => {
  const mockBareRepo = {} as any;
  const mockGitainer = {
    postWebhook: undefined
  } as any;

  afterEach(() => {
    delete process.env.GITAINER_COMMANDS;
  });

  test("POST /api/commands/:name runs the configured docker exec command", async () => {
    process.env.GITAINER_COMMANDS = JSON.stringify({
      "registry-gc": "docker exec registry registry garbage-collect /etc/docker/registry/config.yml",
    });
    const mockDocker = {
      runCommand: async (cmd: string) => {
        expect(cmd).toBe("docker exec registry registry garbage-collect /etc/docker/registry/config.yml");
        return "gc output";
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/commands/registry-gc", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      title: "Gitainer: Webhook",
      name: "registry-gc",
      msg: 'Ran command "registry-gc"',
      output: "gc output",
    });
  });

  test("POST /api/commands/:name returns 404 for unknown command", async () => {
    const mockDocker = {} as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/commands/nope", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ err: 'Unknown command "nope"' });
  });

  test("POST /api/commands/:name returns 400 on docker error", async () => {
    process.env.GITAINER_COMMANDS = JSON.stringify({ boom: "docker exec c echo hi" });
    const mockDocker = {
      runCommand: async () => {
        throw new Error("exec failed");
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/commands/boom", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ err: "exec failed" });
  });

  test("constructor throws when GITAINER_COMMANDS has a non docker-exec command", () => {
    process.env.GITAINER_COMMANDS = JSON.stringify({ bad: "rm -rf /" });
    const mockDocker = {} as any;

    expect(() => new WebhookServer(mockDocker, mockBareRepo, mockGitainer)).toThrow(
      'GITAINER_COMMANDS["bad"] must start with "docker exec"'
    );
  });

  test("constructor throws when GITAINER_COMMANDS is not valid JSON", () => {
    process.env.GITAINER_COMMANDS = "not json";
    const mockDocker = {} as any;

    expect(() => new WebhookServer(mockDocker, mockBareRepo, mockGitainer)).toThrow(
      "GITAINER_COMMANDS is not valid JSON"
    );
  });
});

describe("WebhookServer manager UI read endpoints", () => {
  const stackFiles: Record<string, string> = {
    app: "services:\n  app:\n    image: nginx\n    environment:\n      TOKEN: ${UI_TEST_TOKEN}\n      LEVEL: ${UI_TEST_LEVEL:-info}\n      MISSING: ${UI_TEST_MISSING}",
    gitainer: "services:\n  gitainer:\n    image: gitainer",
    off: "x-gitainer-disabled: true\nservices:\n  app:\n    image: nginx",
    remote: "#@ root@10.0.0.9\nservices:\n  app:\n    image: nginx",
  };
  const mockBareRepo = {
    getAllStackNames: async () => Object.keys(stackFiles),
    getStack: async (name: string) => stackFiles[name],
    headCommit: async () => "abc123",
  } as any;
  const mockGitainer = {
    postWebhook: undefined,
    gitainerDataPath: "/tmp/gitainer-ui-test-missing",
    isSelfStack: (name: string) => name === "gitainer",
  } as any;
  const running = { name: "app-app-1", service: "app", state: "running", status: "Up 2 hours" };

  afterEach(() => {
    delete process.env.GITAINER_API_KEY;
    delete process.env.UI_TEST_TOKEN;
  });

  test("GET / serves the UI without an API key, so it can ask for one", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);

    const res = await server.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("text/html");
    expect((await server.app.request("/ui/app.js")).status).toBe(200);
    expect((await server.app.request("/ui/icon.svg")).headers.get("Content-Type")).toBe("image/svg+xml");
    expect((await server.app.request("/ui/server.ts")).status).toBe(404);
  });

  test("every page of the UI gets the page, so a reload or a shared link works", async () => {
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);
    const page = await (await server.app.request("/")).text();

    for (const path of ["/env", "/history", "/info", "/stacks/app", "/stacks/app/"]) {
      const res = await server.app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(page);
    }
  });

  test("a path that isn't a page gets the UI with a 404, for its not found page", async () => {
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);
    const page = await (await server.app.request("/")).text();

    for (const path of ["/nope", "/stacks", "/stacks/app/extra", "/favicon.ico"]) {
      const res = await server.app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toStartWith("text/html");
      expect(await res.text()).toBe(page);
    }

    // the API keeps its own JSON 404
    const api = await server.app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ err: "Unknown API" });
  });

  test("GET /api/info says which repo to clone, and from where if GITAINER_CLONE_URL is set", async () => {
    const server = new WebhookServer({} as any, mockBareRepo, { ...mockGitainer, repoName: "docker", gitBranch: "main" });

    expect(await (await server.app.request("/api/info")).json()).toEqual({ repoName: "docker", branch: "main" });

    process.env.GITAINER_CLONE_URL = "https://git.example.com/docker.git";
    try {
      expect(await (await server.app.request("/api/info")).json()).toEqual(
        { repoName: "docker", branch: "main", cloneUrl: "https://git.example.com/docker.git" });
    } finally {
      delete process.env.GITAINER_CLONE_URL;
    }
  });

  test("GET /api/settings describes gitainer's settings, without the values that can hold credentials", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    process.env.POST_WEBHOOK = "https://notify.example.com/token-abc";
    process.env.STACK_UPDATE_ON_ENV_CHANGE = "yes";
    process.env.GIT_BRANCH = "main";
    try {
      const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);
      const res = await server.app.request("/api/settings", { headers: { "X-API-Key": "test-secret" } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("test-secret");
      expect(text).not.toContain("token-abc");

      const settings = JSON.parse(text);
      const setting = (key: string) => settings.find((entry: any) => entry.key === key);
      expect(setting("GIT_BRANCH")).toMatchObject({ group: "Git repo", visibility: "plain", set: true, value: "main", default: "main" });
      expect(setting("STACK_UPDATE_ON_ENV_CHANGE")).toMatchObject({ set: true, value: "yes", enabled: true });
      expect(setting("POST_WEBHOOK")).toMatchObject({ visibility: "reveal", set: true });
      expect(setting("GITAINER_API_KEY")).toMatchObject({ visibility: "hidden", set: true });
      expect(setting("INFISICAL_CLIENT_SECRET")).toMatchObject({ visibility: "hidden", set: false });
      expect(settings.every((entry: any) => entry.description)).toBe(true);
    } finally {
      delete process.env.POST_WEBHOOK;
      delete process.env.STACK_UPDATE_ON_ENV_CHANGE;
      delete process.env.GIT_BRANCH;
    }
  });

  test("GET /api/stacks lists each stack with its flags and container states", async () => {
    const hosts: (string | undefined)[] = [];
    const mockDocker = {
      listStackContainers: async (dockerHost?: string) => {
        hosts.push(dockerHost);
        if (dockerHost) {
          throw new Error("ssh://root@10.0.0.9 didn't answer within 8s");
        }
        return new Map([["app", [running]]]);
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "app", self: false, disabled: false, containers: [running] },
      { name: "gitainer", self: true, disabled: false, containers: [] },
      { name: "off", self: false, disabled: true, containers: [] },
      { name: "remote", self: false, disabled: false, remoteHost: "ssh://root@10.0.0.9", statusErr: "ssh://root@10.0.0.9 didn't answer within 8s" },
    ]);
    // one lookup per docker host, not per stack
    expect(hosts.sort()).toEqual(["ssh://root@10.0.0.9", undefined]);
  });

  test("GET /api/stacks?status=local doesn't look up remote hosts", async () => {
    const hosts: (string | undefined)[] = [];
    const mockDocker = {
      listStackContainers: async (dockerHost?: string) => {
        hosts.push(dockerHost);
        return new Map();
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const stacks = await (await server.app.request("/api/stacks?status=local")).json();
    expect(hosts).toEqual([undefined]);
    expect(stacks.find((stack: any) => stack.name === "remote")).toEqual({ name: "remote", self: false, disabled: false, remoteHost: "ssh://root@10.0.0.9" });
  });

  test("GET /api/stacks/:stackName/status looks up one stack on its host", async () => {
    const lookups: unknown[][] = [];
    const mockDocker = {
      listStackContainers: async (...args: unknown[]) => {
        lookups.push(args);
        return new Map([["remote", [running]]]);
      },
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/remote/status");
    expect(await res.json()).toEqual({ name: "remote", self: false, disabled: false, remoteHost: "ssh://root@10.0.0.9", containers: [running] });
    expect(lookups).toEqual([["ssh://root@10.0.0.9", "remote"]]);

    expect((await server.app.request("/api/stacks/nope/status")).status).toBe(404);
  });

  test("GET /api/stacks/:stackName/resolved is refused unless an API key is configured", async () => {
    const mockDocker = {
      composeResolved: async (composeString: string, stackName: string) => `name: ${stackName}\n`,
    } as any;
    const server = new WebhookServer(mockDocker, mockBareRepo, mockGitainer);

    const refused = await server.app.request("/api/stacks/app/resolved");
    expect(refused.status).toBe(403);

    process.env.GITAINER_API_KEY = "test-secret";
    const res = await server.app.request("/api/stacks/app/resolved", { headers: { "X-API-Key": "test-secret" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("name: app\n");

    expect((await server.app.request("/api/stacks/nope/resolved", { headers: { "X-API-Key": "test-secret" } })).status).toBe(404);
  });

  test("GET /api/stacks/:stackName/variables says which variables are set, without values", async () => {
    process.env.UI_TEST_TOKEN = "hunter2";
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/stacks/app/variables");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toEqual([
      { name: "UI_TEST_LEVEL", hasDefault: true, required: false, set: false },
      { name: "UI_TEST_MISSING", hasDefault: false, required: false, set: false },
      { name: "UI_TEST_TOKEN", hasDefault: false, required: false, set: true },
    ]);
  });

  test("GET /api/env lists keys with the stacks reading them, without values", async () => {
    process.env.UI_TEST_TOKEN = "hunter2";
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);

    const res = await server.app.request("/api/env", { headers: { "X-API-Key": "test-secret" } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("test-secret");

    const body = JSON.parse(text);
    expect(body.env.find((entry: any) => entry.key === "UI_TEST_TOKEN")).toEqual(
      { key: "UI_TEST_TOKEN", source: "container", stacks: ["app"], staleStacks: [], revealable: true });
    expect(body.env.find((entry: any) => entry.key === "GITAINER_API_KEY").revealable).toBe(false);
    expect(body.unset).toEqual([
      { key: "UI_TEST_LEVEL", stacks: ["app"], hasDefault: true, required: false },
      { key: "UI_TEST_MISSING", stacks: ["app"], hasDefault: false, required: false },
    ]);
  });

  test("the variables of a stack are read once per commit", async () => {
    let commit = "abc123";
    let reads = 0;
    const countingRepo = {
      ...mockBareRepo,
      headCommit: async () => commit,
      getStack: async (name: string) => {
        reads++;
        return stackFiles[name];
      },
    } as any;
    const server = new WebhookServer({} as any, countingRepo, mockGitainer);

    await server.app.request("/api/env");
    await server.app.request("/api/env");
    expect(reads).toBe(Object.keys(stackFiles).length);

    commit = "def456";
    await server.app.request("/api/env");
    expect(reads).toBe(2 * Object.keys(stackFiles).length);
  });

  test("GET /api/env/:key reveals one value, only with an API key configured", async () => {
    process.env.UI_TEST_TOKEN = "hunter2";
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);

    expect((await server.app.request("/api/env/UI_TEST_TOKEN")).status).toBe(403);

    process.env.GITAINER_API_KEY = "test-secret";
    const headers = { "X-API-Key": "test-secret" };
    const res = await server.app.request("/api/env/UI_TEST_TOKEN", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "UI_TEST_TOKEN", value: "hunter2" });

    expect((await server.app.request("/api/env/UI_TEST_MISSING", { headers })).status).toBe(404);
  });

  test("GET /api/env/:key never reveals gitainer's own credentials", async () => {
    process.env.GITAINER_API_KEY = "test-secret";
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);

    for (const key of ["GITAINER_API_KEY", "WEBHOOK_API_KEY", "INFISICAL_CLIENT_SECRET"]) {
      const res = await server.app.request(`/api/env/${key}`, { headers: { "X-API-Key": "test-secret" } });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("test-secret");
    }
  });
});

describe("WebhookServer per-stack action lock", () => {
  const mockBareRepo = {
    getStack: async (name: string) => name === "existing" || name === "other"
      ? "services:\n  app:\n    image: nginx"
      : null,
  } as any;
  const mockGitainer = {
    postWebhook: undefined,
    isSelfStack: () => false,
  } as any;

  // a docker whose composeDown() hangs until release() is called
  function blockingDocker() {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => release = resolve);
    const docker = {
      composePull: async () => {},
      composeDown: async () => {
        await blocked;
        return { text: () => "downed", stderr: "Container app Removed" };
      },
      composeUpdate: async () => ({ text: () => "updated" }),
      composeUp: async () => {
        throw new Error("no such image");
      },
      listStackContainers: async () => new Map(),
    } as any;
    return { docker, release };
  }

  test("a second action on a stack with one in flight is refused with a 409", async () => {
    const { docker, release } = blockingDocker();
    const server = new WebhookServer(docker, mockBareRepo, mockGitainer);

    const first = server.app.request("/api/stacks/existing/down", { method: "POST" });
    await Bun.sleep(10);

    for (const path of ["/api/stacks/existing", "/api/stacks/existing/down", "/api/stacks/existing/up", "/api/stacks/existing/restart"]) {
      const res = await server.app.request(path, { method: "POST" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ err: "Stack existing already has a down in progress" });
    }
    expect((await (await server.app.request("/api/stacks/existing/status")).json()).busy).toBe("down");

    release();
    expect((await first).status).toBe(200);
  });

  test("the lock is per stack, and released when the action ends", async () => {
    const { docker, release } = blockingDocker();
    const server = new WebhookServer(docker, mockBareRepo, mockGitainer);

    const first = server.app.request("/api/stacks/existing/down", { method: "POST" });
    await Bun.sleep(10);

    // another stack isn't blocked, and a failed action releases its lock too
    expect((await server.app.request("/api/stacks/other/up", { method: "POST" })).status).toBe(400);
    expect((await server.app.request("/api/stacks/other/up", { method: "POST" })).status).toBe(400);

    release();
    await first;
    expect((await server.app.request("/api/stacks/existing/down", { method: "POST" })).status).toBe(200);
  });

  test("each action is stored as an event with its deploy", async () => {
    const { docker, release } = blockingDocker();
    const store = new EventStore(":memory:");
    const server = new WebhookServer(docker, { ...mockBareRepo, headCommit: async () => "abc123" }, { ...mockGitainer, store });
    release();

    await server.app.request("/api/stacks/existing/down", { method: "POST" });
    await server.app.request("/api/stacks/other/up", { method: "POST" });

    const deploys = await (await server.app.request("/api/deploys")).json();
    expect(deploys).toMatchObject([
      { stack: "other", action: "up", ok: false, output: "no such image", trigger: "Webhook", commit: "abc123" },
      // compose reports its progress on stderr
      { stack: "existing", action: "down", ok: true, output: "downed\nContainer app Removed", trigger: "Webhook", commit: "abc123" },
    ]);
    expect(await (await server.app.request("/api/deploys?stack=existing")).json()).toHaveLength(1);

    const events = await (await server.app.request("/api/events")).json();
    expect(events).toMatchObject([
      // a failure isn't sent to POST_WEBHOOK, but is stored
      { type: "Webhook", ok: false, message: "no such image", payload: { title: "Gitainer: Webhook", stackName: "other", err: "no such image" }, deploys: [{ stack: "other" }] },
      { type: "Webhook", ok: true, message: "Successfully downed stack existing: downed", deploys: [{ stack: "existing" }] },
    ]);
    await store.close();
  });

  test("an action from the UI is labelled UI, in the history and for POST_WEBHOOK", async () => {
    const { docker, release } = blockingDocker();
    const store = new EventStore(":memory:");
    const server = new WebhookServer(docker, { ...mockBareRepo, headCommit: async () => "abc123" }, { ...mockGitainer, store });
    release();

    const res = await server.app.request("/api/stacks/existing/down", { method: "POST", headers: { "X-Gitainer-Source": "ui" } });
    expect((await res.json()).title).toBe("Gitainer: UI");
    await server.app.request("/api/stacks/existing/down", { method: "POST" });

    expect(await store.listEvents()).toMatchObject([
      { type: "Webhook", payload: { title: "Gitainer: Webhook" }, deploys: [{ trigger: "Webhook" }] },
      { type: "UI", payload: { title: "Gitainer: UI" }, deploys: [{ trigger: "UI" }] },
    ]);
    await store.close();
  });

  test("a stack deployed with another value of a variable it reads has a stale env, until it's deployed again", async () => {
    const { docker, release } = blockingDocker();
    release();
    const store = new EventStore(":memory:");
    const repo = {
      getAllStackNames: async () => ["existing"],
      getStack: async (name: string) => name === "existing" ? "services:\n  app:\n    image: nginx\n    environment:\n      TOKEN: ${STALE_TEST_TOKEN}\n      OTHER: ${STALE_TEST_OTHER}" : null,
      headCommit: async () => "abc123",
    } as any;
    const server = new WebhookServer(docker, repo, { ...mockGitainer, store });
    const stack = async () => (await (await server.app.request("/api/stacks")).json())[0];
    const envEntry = async () => (await (await server.app.request("/api/env")).json()).env.find((entry: any) => entry.key === "STALE_TEST_TOKEN");

    process.env.STALE_TEST_TOKEN = "first";
    try {
      // never deployed through gitainer: nothing to compare against
      expect((await stack()).staleEnv).toBeUndefined();

      await server.app.request("/api/stacks/existing/restart", { method: "POST" });
      expect((await stack()).staleEnv).toBeUndefined();
      expect((await envEntry()).staleStacks).toEqual([]);

      process.env.STALE_TEST_TOKEN = "second";
      expect((await stack()).staleEnv).toEqual(["STALE_TEST_TOKEN"]);
      expect((await envEntry()).staleStacks).toEqual(["existing"]);
      // hashes, not values
      expect(JSON.stringify([...await store.listStackEnvs()])).not.toContain("first");

      await server.app.request("/api/stacks/existing/restart", { method: "POST" });
      expect((await stack()).staleEnv).toBeUndefined();

      // a downed stack runs with no env at all
      process.env.STALE_TEST_TOKEN = "third";
      await server.app.request("/api/stacks/existing/down", { method: "POST" });
      expect((await stack()).staleEnv).toBeUndefined();
    } finally {
      delete process.env.STALE_TEST_TOKEN;
      await store.close();
    }
  });

  test("the history is empty without a store", async () => {
    const server = new WebhookServer({} as any, mockBareRepo, mockGitainer);

    expect(await (await server.app.request("/api/events")).json()).toEqual([]);
    expect(await (await server.app.request("/api/deploys")).json()).toEqual([]);
  });
});
