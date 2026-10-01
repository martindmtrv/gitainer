import { SQL } from "bun";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { webhookTitle, type WebhookEventType } from "../webhooks/WebhookEventType";
import type { EnvFingerprint } from "../server/stackEnv";

// the newest rows kept in each table, so the database doesn't grow without bound
const MAX_EVENTS = 2_000;
const MAX_DEPLOYS = 10_000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** What happened to one stack: a deploy, a down, or any other action that touched it. */
export interface DeployRecord {
  stack: string;
  // deploy, down, pull, rollback, self-update from a synthesis; update, up, down, restart from the API
  action: string;
  ok: boolean;
  // what the command printed, or why it failed
  output: string;
  // the commit `main` was at, i.e. the version of the stack that was acted on
  commit?: string;
  startedAt: string;
  finishedAt: string;
}

export interface StoredDeploy extends DeployRecord {
  id: number;
  eventId: number;
  // what caused it: "Git Push", "Env Update", "Webhook" or "UI"
  trigger: string;
}

export interface StoredEvent {
  id: number;
  type: string;
  ok: boolean;
  // the payload's `msg` or `err`
  message: string;
  // the result as POST_WEBHOOK gets it. Failures that aren't sent to POST_WEBHOOK are stored too
  payload: Record<string, unknown>;
  createdAt: string;
  deploys: StoredDeploy[];
}

function clampLimit(limit?: number): number {
  return Number.isInteger(limit) && (limit as number) > 0 ? Math.min(limit as number, MAX_LIMIT) : DEFAULT_LIMIT;
}

function toDeploy(row: any): StoredDeploy {
  return {
    id: row.id,
    eventId: row.event_id,
    trigger: row.trigger,
    stack: row.stack,
    action: row.action,
    ok: !!row.ok,
    output: row.output,
    ...(row.commit_hash ? { commit: row.commit_hash } : {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The history of what gitainer did, in a SQLite database: every webhook event (the result of a
 * synthesis or of an API action, as POST_WEBHOOK gets it) and the deploys each one made. Holds
 * no env values: compose files are stored as they are in git, with their `${VARS}`.
 */
export class EventStore {
  private readonly sql: SQL;
  private readonly ready: Promise<void>;
  private readonly filename: string;

  /** `filename` is the database file, created if it's missing, or `:memory:`. */
  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
      // Readable only by its owner, like the env snapshots next to it: the hashes in stack_env
      // would let a short secret be guessed. Created before sqlite opens it, so the journal
      // files sqlite adds beside it get the same mode. The chmod tightens an existing file.
      closeSync(openSync(filename, "a", 0o600));
      chmodSync(filename, 0o600);
    }
    this.filename = filename;
    this.sql = new SQL({ adapter: "sqlite", filename });
    this.ready = this.migrate();
    // reported by whichever call awaits it first
    this.ready.catch(() => {});
  }

  private async migrate() {
    if (this.filename !== ":memory:") {
      // A write-ahead log, synced at checkpoints rather than on every commit: recording an event
      // is awaited in the middle of a deploy, and must not hang on a disk that's slow to sync.
      // What a power cut can lose is the last few events, never the database.
      await this.sql`PRAGMA journal_mode = WAL`;
      await this.sql`PRAGMA synchronous = NORMAL`;
    }

    // in one transaction, so creating the schema is a single write
    await this.sql.begin(async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS webhook_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          ok INTEGER NOT NULL,
          message TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`;
      await tx`
        CREATE TABLE IF NOT EXISTS deploys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL REFERENCES webhook_events(id),
          trigger TEXT NOT NULL,
          stack TEXT NOT NULL,
          action TEXT NOT NULL,
          ok INTEGER NOT NULL,
          output TEXT NOT NULL,
          commit_hash TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL
        )`;
      await tx`CREATE INDEX IF NOT EXISTS deploys_stack ON deploys (stack, id)`;
      await tx`CREATE INDEX IF NOT EXISTS deploys_event ON deploys (event_id)`;
      // the env each stack was last deployed with, see recordStackEnv()
      await tx`
        CREATE TABLE IF NOT EXISTS stack_env (
          stack TEXT PRIMARY KEY,
          variables TEXT NOT NULL,
          deployed_at TEXT NOT NULL
        )`;
    });
  }

  /**
   * Stores an event and the deploys it made. `payload` is the result object, with its outcome
   * in `msg` or `err`. Never throws: a broken database must not fail the deploy it's recording.
   */
  async recordEvent(type: WebhookEventType, payload: Record<string, unknown>, deploys: DeployRecord[] = []): Promise<void> {
    try {
      await this.ready;
      const failed = payload.err !== undefined && payload.err !== null;
      await this.sql.begin(async (tx) => {
        const [{ id }] = await tx`
          INSERT INTO webhook_events ${tx({
            type,
            ok: failed ? 0 : 1,
            message: String(failed ? payload.err : payload.msg ?? ""),
            payload: JSON.stringify({ title: webhookTitle(type), ...payload }),
            created_at: new Date().toISOString(),
          })} RETURNING id`;

        for (const deploy of deploys) {
          await tx`
            INSERT INTO deploys ${tx({
              event_id: id,
              trigger: type,
              stack: deploy.stack,
              action: deploy.action,
              ok: deploy.ok ? 1 : 0,
              output: deploy.output,
              commit_hash: deploy.commit ?? null,
              started_at: deploy.startedAt,
              finished_at: deploy.finishedAt,
            })}`;
        }

        // an event's deploys are dropped along with it
        await tx`DELETE FROM deploys WHERE id <= (SELECT MAX(id) FROM deploys) - ${MAX_DEPLOYS}`;
        await tx`DELETE FROM deploys WHERE event_id <= (SELECT MAX(id) FROM webhook_events) - ${MAX_EVENTS}`;
        await tx`DELETE FROM webhook_events WHERE id <= (SELECT MAX(id) FROM webhook_events) - ${MAX_EVENTS}`;
      });
    } catch (e) {
      console.error("Failed to store the event:", e);
    }
  }

  /** The newest events first, each with its deploys. */
  async listEvents(limit?: number): Promise<StoredEvent[]> {
    await this.ready;
    const events = await this.sql`SELECT * FROM webhook_events ORDER BY id DESC LIMIT ${clampLimit(limit)}`;
    if (events.length === 0) {
      return [];
    }

    const oldest = events[events.length - 1].id;
    const newest = events[0].id;
    const deploys: StoredDeploy[] = (await this.sql`
      SELECT * FROM deploys WHERE event_id BETWEEN ${oldest} AND ${newest} ORDER BY id`).map(toDeploy);

    return events.map((row: any) => ({
      id: row.id,
      type: row.type,
      ok: !!row.ok,
      message: row.message,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
      deploys: deploys.filter(deploy => deploy.eventId === row.id),
    }));
  }

  /** The newest deploys first: of every stack, or of `stack` only. */
  async listDeploys(stack?: string, limit?: number): Promise<StoredDeploy[]> {
    await this.ready;
    const rows = stack
      ? await this.sql`SELECT * FROM deploys WHERE stack = ${stack} ORDER BY id DESC LIMIT ${clampLimit(limit)}`
      : await this.sql`SELECT * FROM deploys ORDER BY id DESC LIMIT ${clampLimit(limit)}`;
    return rows.map(toDeploy);
  }

  /** Remembers the env a stack was just deployed with, replacing what was remembered before. */
  async recordStackEnv(stack: string, variables: EnvFingerprint): Promise<void> {
    await this.ready;
    await this.sql`
      INSERT INTO stack_env ${this.sql({ stack, variables: JSON.stringify(variables), deployed_at: new Date().toISOString() })}
      ON CONFLICT (stack) DO UPDATE SET variables = excluded.variables, deployed_at = excluded.deployed_at`;
  }

  /** Forgets the env of a stack that was taken down: it's running with no env at all. Never throws. */
  async clearStackEnv(stack: string): Promise<void> {
    try {
      await this.ready;
      await this.sql`DELETE FROM stack_env WHERE stack = ${stack}`;
    } catch (e) {
      console.error(`Could not clear the env ${stack} was deployed with:`, e);
    }
  }

  /** The env each stack was last deployed with, by stack. */
  async listStackEnvs(): Promise<Map<string, EnvFingerprint>> {
    await this.ready;
    const rows = await this.sql`SELECT stack, variables FROM stack_env`;
    return new Map(rows.map((row: any) => [row.stack, JSON.parse(row.variables)]));
  }

  async close() {
    await this.sql.close();
  }
}
