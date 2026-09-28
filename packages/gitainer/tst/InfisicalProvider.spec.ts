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

    test("returns false without a cache when Infisical is unreachable", async () => {
      useDataDir();
      const downSpy = spyOn(InfisicalProvider, "getSecrets").mockImplementation(async () => undefined);

      expect(await InfisicalProvider.updateProcessEnv()).toBe(false);

      downSpy.mockRestore();
    });
  });
});
