import { expect, test, describe, afterEach } from "bun:test";
import { WebhookServer } from "../src/webhooks/WebhookServer";

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
