import { expect, test, describe, spyOn, afterEach } from "bun:test";
import * as InfisicalProvider from "../src/infisical/InfisicalProvider";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function secret(secretKey: string, secretValue: string) {
  return { secretKey, secretValue } as any;
}

describe("InfisicalProvider", () => {
  afterEach(() => {
    // Clean up process.env after each test if needed
    delete process.env.TEST_SECRET;
    delete process.env.MULTILINE_SECRET;
  });

  test("updateProcessEnv flattens multiline secrets", async () => {
    // Mock getSecrets to return a multiline secret
    const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => {
      return [
        {
          secretKey: "MULTILINE_SECRET",
          secretValue: "line1\nline2\nline3",
          version: 1,
          workspace: "ws",
          id: "1",
          environment: "dev",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any
      ];
    });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await InfisicalProvider.updateProcessEnv();

    expect(result).toBe(true);
    expect(process.env.MULTILINE_SECRET).toBe("line1 line2 line3");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Secret "MULTILINE_SECRET" contains newlines'));

    getSecretsSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("updateProcessEnv does not change single line secrets", async () => {
    const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => {
      return [
        {
          secretKey: "SINGLE_LINE",
          secretValue: "normal-value",
          version: 1,
          workspace: "ws",
          id: "2",
          environment: "dev",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any
      ];
    });

    const result = await InfisicalProvider.updateProcessEnv();

    expect(result).toBe(true);
    expect(process.env.SINGLE_LINE).toBe("normal-value");

    getSecretsSpy.mockRestore();
  });

  describe("cache and precedence", () => {
    let dataDir: string;
    const originalDataDir = process.env.GITAINER_DATA;

    afterEach(() => {
      delete process.env.CACHED_SECRET;
      delete process.env.OTHER_SECRET;
      rmSync(dataDir, { recursive: true, force: true });
      if (originalDataDir === undefined) {
        delete process.env.GITAINER_DATA;
      } else {
        process.env.GITAINER_DATA = originalDataDir;
      }
    });

    const useDataDir = () => {
      dataDir = mkdtempSync(join(tmpdir(), "gitainer-infisical-"));
      process.env.GITAINER_DATA = dataDir;
    };

    test("overrides keys already in gitainer's environment", async () => {
      useDataDir();
      process.env.OTHER_SECRET = "from-dotenv";
      const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
        secret("OTHER_SECRET", "from-infisical"),
      ]);

      expect(await InfisicalProvider.updateProcessEnv()).toBe(true);
      expect(process.env.OTHER_SECRET).toBe("from-infisical");

      getSecretsSpy.mockRestore();
    });

    test("writes fetched secrets to a private cache file", async () => {
      useDataDir();
      const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
        secret("CACHED_SECRET", "v1"),
      ]);

      await InfisicalProvider.updateProcessEnv();

      const cachePath = join(dataDir, "infisicalCache.json");
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ CACHED_SECRET: "v1" });
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
      expect(existsSync(`${cachePath}.tmp`)).toBe(false);

      getSecretsSpy.mockRestore();
    });

    test("applies the cache over existing env when Infisical is unreachable", async () => {
      useDataDir();
      const liveSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
        secret("CACHED_SECRET", "cached"),
        secret("OTHER_SECRET", "cached-too"),
      ]);
      await InfisicalProvider.updateProcessEnv();
      liveSpy.mockRestore();

      // simulate a restart: CACHED_SECRET is gone, OTHER_SECRET is back to its .env value
      Reflect.deleteProperty(process.env, "CACHED_SECRET");
      process.env.OTHER_SECRET = "from-dotenv";

      const downSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => undefined);

      expect(await InfisicalProvider.updateProcessEnv()).toBe(true);
      expect(process.env.CACHED_SECRET).toBe("cached");
      expect(process.env.OTHER_SECRET).toBe("cached-too");

      // env already matches the cache on the next failed poll
      expect(await InfisicalProvider.updateProcessEnv()).toBe(false);

      downSpy.mockRestore();
    });

    describe("bootstrap cache", () => {
      const originalBootstrap = Object.fromEntries(InfisicalProvider.BOOTSTRAP_KEYS.map(key => [key, process.env[key]]));

      afterEach(() => {
        for (const [key, value] of Object.entries(originalBootstrap)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      });

      test("keeps only the Infisical settings of a successful fetch, privately", async () => {
        useDataDir();
        process.env.INFISICAL_URL = "https://infisical.example";
        process.env.INFISICAL_CLIENT_SECRET = "client-secret";
        const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
          secret("CACHED_SECRET", "v1"),
        ]);

        await InfisicalProvider.updateProcessEnv();

        const bootstrapPath = join(dataDir, "infisicalBootstrap.json");
        const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8"));
        expect(bootstrap.INFISICAL_URL).toBe("https://infisical.example");
        expect(bootstrap.INFISICAL_CLIENT_SECRET).toBe("client-secret");
        expect(bootstrap.CACHED_SECRET).toBeUndefined();
        expect(statSync(bootstrapPath).mode & 0o777).toBe(0o600);

        getSecretsSpy.mockRestore();
      });

      test("loads unset Infisical settings before fetching, without a .env", async () => {
        useDataDir();
        process.env.INFISICAL_URL = "https://infisical.example";
        process.env.INFISICAL_CLIENT_ID = "client-id";
        const liveSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
          secret("CACHED_SECRET", "v1"),
        ]);
        await InfisicalProvider.updateProcessEnv();
        liveSpy.mockRestore();

        // simulate a restart without .env: only the explicitly set client id is present
        delete process.env.INFISICAL_URL;
        process.env.INFISICAL_CLIENT_ID = "rotated-client-id";

        let urlAtFetch: string | undefined;
        const fetchSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => {
          urlAtFetch = process.env.INFISICAL_URL;
          return undefined;
        });

        await InfisicalProvider.updateProcessEnv();

        expect(urlAtFetch).toBe("https://infisical.example");
        expect(process.env.INFISICAL_CLIENT_ID).toBe("rotated-client-id");

        fetchSpy.mockRestore();
      });

      test("switches to Infisical settings stored in Infisical once they connect", async () => {
        useDataDir();
        process.env.INFISICAL_URL = "https://infisical.example";
        process.env.INFISICAL_CLIENT_SECRET = "old-secret";
        const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
          secret("CACHED_SECRET", "v1"),
          secret("INFISICAL_CLIENT_SECRET", "new-secret"),
        ]);
        const switchSpy = spyOn(InfisicalProvider, "switchSettings").mockImplementation(async () => true);
        const logSpy = spyOn(console, "log").mockImplementation(() => {});

        await InfisicalProvider.updateProcessEnv();

        expect(switchSpy).toHaveBeenCalledWith({ INFISICAL_URL: "https://infisical.example", INFISICAL_CLIENT_SECRET: "new-secret" });
        expect(process.env.INFISICAL_CLIENT_SECRET).toBe("new-secret");
        expect(JSON.parse(readFileSync(join(dataDir, "infisicalBootstrap.json"), "utf8")).INFISICAL_CLIENT_SECRET).toBe("new-secret");
        // Infisical settings stay out of the secrets cache, so the outage fallback never applies unverified ones
        expect(JSON.parse(readFileSync(join(dataDir, "infisicalCache.json"), "utf8"))).toEqual({ CACHED_SECRET: "v1" });

        // already in use on the next poll, so nothing to verify
        switchSpy.mockClear();
        await InfisicalProvider.updateProcessEnv();
        expect(switchSpy).not.toHaveBeenCalled();

        getSecretsSpy.mockRestore();
        switchSpy.mockRestore();
        logSpy.mockRestore();
      });

      test("keeps the current Infisical settings when the ones in Infisical fail, and only tries them once", async () => {
        useDataDir();
        process.env.INFISICAL_URL = "https://infisical.example";
        process.env.INFISICAL_CLIENT_SECRET = "working-secret";
        const getSecretsSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => [
          secret("CACHED_SECRET", "v1"),
          secret("INFISICAL_CLIENT_SECRET", "typo-secret"),
        ]);
        const switchSpy = spyOn(InfisicalProvider, "switchSettings").mockImplementation(async () => false);
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});

        await InfisicalProvider.updateProcessEnv();
        await InfisicalProvider.updateProcessEnv();

        expect(switchSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(process.env.INFISICAL_CLIENT_SECRET).toBe("working-secret");
        expect(JSON.parse(readFileSync(join(dataDir, "infisicalBootstrap.json"), "utf8")).INFISICAL_CLIENT_SECRET).toBe("working-secret");

        getSecretsSpy.mockRestore();
        switchSpy.mockRestore();
        errorSpy.mockRestore();
      });
    });

    test("returns false without a cache when Infisical is unreachable", async () => {
      useDataDir();
      const downSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => undefined);

      expect(await InfisicalProvider.updateProcessEnv()).toBe(false);

      downSpy.mockRestore();
    });
  });
});
