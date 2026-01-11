import { expect, test, describe, spyOn, afterEach } from "bun:test";
import * as InfisicalProvider from "../src/infisical/InfisicalProvider";

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
});
