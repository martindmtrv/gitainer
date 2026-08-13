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
