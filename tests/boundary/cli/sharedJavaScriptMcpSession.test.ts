import { expect, test } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliTest,
  type SharedMcpCall,
  type TestCli,
} from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  resolveJavaScriptApplicationMcpCall,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/workspace/writeFixtureFiles.js";

const unusedCli = {
  run: async () => {
    throw new Error("CLI was not requested");
  },
} as TestCli;

test("prefers an explicit JavaScript MCP caller over the file session", async () => {
  const explicit = (async () => ({
    isError: false,
  })) as unknown as SharedMcpCall;
  let sharedCalls = 0;
  const resolved = await resolveJavaScriptApplicationMcpCall(
    {
      ...unusedCli,
      sharedMcpCall: async () => {
        sharedCalls += 1;
        return explicit;
      },
    },
    explicit,
  );
  expect(resolved).toBe(explicit);
  expect(sharedCalls).toBe(0);
});

test("uses the file session when the case does not own a server", async () => {
  const shared = (async () => ({ isError: false })) as unknown as SharedMcpCall;
  const resolved = await resolveJavaScriptApplicationMcpCall(
    {
      ...unusedCli,
      sharedMcpCall: async () => shared,
    },
    undefined,
  );
  expect(resolved).toBe(shared);
});

const writeApplication = async (prefix: string): Promise<string> => {
  const root = await createTestTempDirectory(prefix);
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ main: "main.cjs" }),
    "main.cjs":
      'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
    "index.html": "page",
  });
  return root;
};

let fileSession: SharedMcpCall | undefined;

cliTest(
  "opens one stdio MCP session for JavaScript application cases",
  async ({ cli }) => {
    const open = cli.sharedMcpCall;
    if (open === undefined)
      throw new Error("cliTest did not provide a shared MCP session");
    const first = await open();
    expect(await open()).toBe(first);
    fileSession = first;
    const root = await writeApplication("rea-shared-mcp-");
    const analyzed = await analyzeJavaScriptDirectory("stdio MCP", cli, root);
    expect(
      analyzed.graph.nodes.some(({ kind }) => kind === "electron-renderer"),
    ).toBe(true);
  },
);

cliTest(
  "reuses that stdio MCP session for a later case in the file",
  async ({ cli }) => {
    const open = cli.sharedMcpCall;
    if (open === undefined)
      throw new Error("cliTest did not provide a shared MCP session");
    expect(fileSession).toBeDefined();
    expect(await open()).toBe(fileSession);
    const root = await writeApplication("rea-shared-mcp-later-");
    const analyzed = await analyzeJavaScriptDirectory("stdio MCP", cli, root);
    expect(
      analyzed.graph.nodes.some(({ kind }) => kind === "electron-renderer"),
    ).toBe(true);
  },
);
