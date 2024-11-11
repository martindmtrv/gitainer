import { serve, type Server } from "bun";
import { Hono } from "hono";
import type { GitChange } from "../../src/git/GitChange";

export class NotifyWebhookTestHelper {
  readonly server: Hono;
  readonly listener: Server;

  callback?: (body: { msg: string, err?: string, changes?: GitChange[], failedStack?: string }) => void;

  constructor(path: string, port: number) {
    this.server = new Hono();

    this.server.post(path, async (c) => {
      if (this.callback) {
        const body = await c.req.json();
        console.log("[NotifyWebhookTestHelper] got POST", body);
        this.callback(body);
      }
      return c.json({ ok: true });
    });

    this.listener = serve({
      fetch: this.server.fetch,
      port,
    });
  }
}
