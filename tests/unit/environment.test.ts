import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

function writeEnvironment(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "universal-api-environment-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, ".env"), contents);
  return directory;
}

async function freshEnvironmentLoader() {
  vi.resetModules();
  return import("../../src/config/environment.js");
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.resetModules();
});

describe("environment configuration", () => {
  it("uses local .env Crawl4AI configuration over stale development process variables", async () => {
    process.chdir(writeEnvironment("NODE_ENV=development\nCRAWL4AI_BASE_URL=http://file-sidecar.test:11235\nCRAWL4AI_TOKEN=file-token\n"));
    process.env.NODE_ENV = "development";
    process.env.CRAWL4AI_BASE_URL = "http://stale-shell.test:11235";
    process.env.CRAWL4AI_TOKEN = "stale-shell-token";

    const { loadEnvironment } = await freshEnvironmentLoader();
    const environment = loadEnvironment();

    expect(environment.crawl4aiBaseUrl).toBe("http://file-sidecar.test:11235");
    expect(environment.crawl4aiToken).toBe("file-token");
  });

  it("does not load local .env in production", async () => {
    process.chdir(writeEnvironment("NODE_ENV=development\nCRAWL4AI_TOKEN=file-token\n"));
    process.env.NODE_ENV = "production";
    process.env.CRAWL4AI_TOKEN = "production-token";

    const { loadEnvironment } = await freshEnvironmentLoader();
    expect(loadEnvironment().crawl4aiToken).toBe("production-token");
  });

  it("returns the current local Crawl4AI token from the Environment boundary", async () => {
    const expected = parseEnv(readFileSync(join(originalCwd, ".env"), "utf8")).CRAWL4AI_TOKEN;
    process.chdir(originalCwd);
    process.env.NODE_ENV = "development";
    process.env.CRAWL4AI_TOKEN = "stale-shell-token";

    const { loadEnvironment } = await freshEnvironmentLoader();
    expect(loadEnvironment().crawl4aiToken).toBe(expected);
  });
});
