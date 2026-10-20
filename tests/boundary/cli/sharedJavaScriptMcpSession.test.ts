import { expect, test } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliTest,
  createSharedMcpSession,
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

/** Record the first selected case and compare later cases when they also run. */
const useFileSession = async (cli: TestCli): Promise<SharedMcpCall> => {
  const open = cli.sharedMcpCall;
  if (open === undefined)
    throw new Error("cliTest did not provide a shared MCP session");
  const current = await open();
  if (fileSession === undefined) fileSession = current;
  else expect(current).toBe(fileSession);
  return current;
};

const held = (): { gate: Promise<void>; release: () => void } => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};

const fakeCall = (async () => ({
  isError: false,
})) as unknown as SharedMcpCall;

test("does not open a shared MCP server after file cleanup starts", async () => {
  const startup = held();
  let opened = false;
  const session = createSharedMcpSession(async (_registerCleanup, isClosed) => {
    await startup.gate;
    if (isClosed()) throw new Error("Shared MCP session is closed");
    opened = true;
    return fakeCall;
  });
  const opening = session.session.call();
  const closing = session.close();
  startup.release();
  await closing;
  await expect(opening).rejects.toThrow("Shared MCP session is closed");
  expect(opened).toBe(false);
  await expect(session.session.call()).rejects.toThrow(
    "Shared MCP session is closed",
  );
});

test("closes a shared MCP server registered after file cleanup starts", async () => {
  const startup = held();
  let closedServer = false;
  const session = createSharedMcpSession(async (registerCleanup) => {
    await startup.gate;
    registerCleanup(async () => {
      closedServer = true;
    });
    return fakeCall;
  });
  const opening = session.session.call();
  const closing = session.close();
  startup.release();
  await closing;
  await expect(opening).rejects.toThrow("Shared MCP session is closed");
  expect(closedServer).toBe(true);
});

cliTest(
  "opens one stdio MCP session for JavaScript application cases",
  async ({ cli }) => {
    const first = await useFileSession(cli);
    expect(await useFileSession(cli)).toBe(first);
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
    await useFileSession(cli);
    const root = await writeApplication("rea-shared-mcp-later-");
    const analyzed = await analyzeJavaScriptDirectory("stdio MCP", cli, root);
    expect(
      analyzed.graph.nodes.some(({ kind }) => kind === "electron-renderer"),
    ).toBe(true);
  },
);
