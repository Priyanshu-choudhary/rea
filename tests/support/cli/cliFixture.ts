import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../workspace/workspaceFixture.js";
import {
  processTest,
  type ProcessResult,
  type TestProcesses,
} from "../process/processFixture.js";

/** Caller-controlled values for one compiled REA CLI invocation. */
export interface CliInvocation {
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
}

/** Normalized result from the compiled REA CLI. */
export interface CliResult extends ProcessResult {
  readonly json: unknown | undefined;
}

/** One compiled stdio MCP tool call. */
export type SharedMcpCall = Awaited<
  ReturnType<
    typeof import("../../fixtures/localToolsMcp.js").connectLocalToolsMcp
  >
>["call"];

/** Compiled REA CLI driver owned by one test. */
export interface TestCli {
  run(invocation: CliInvocation): Promise<CliResult>;
  /**
   * File-scoped stdio MCP caller. Present on `cliTest` drivers and absent for
   * drivers created with `createTestCli` alone.
   */
  sharedMcpCall?(): Promise<SharedMcpCall>;
}

interface FileMcpSession {
  call(): Promise<SharedMcpCall>;
}

/** Start at most one stdio server for the file, including after a failed handshake. */
const createFileMcpSession = (
  compileCache: string,
): { session: FileMcpSession; close(): Promise<void> } => {
  let pending: Promise<SharedMcpCall> | undefined;
  const cleanups: Array<() => Promise<void>> = [];
  const closeFailedHandshake = async (): Promise<void> => {
    const failed = cleanups.splice(0).reverse();
    for (const cleanup of failed) await cleanup();
  };
  return {
    session: {
      call: () => {
        pending ??= import("../../fixtures/localToolsMcp.js")
          .then(({ connectLocalToolsMcp }) =>
            connectLocalToolsMcp(
              { NODE_COMPILE_CACHE: compileCache },
              (cleanup) => {
                cleanups.push(cleanup);
              },
            ),
          )
          .then((mcp) => mcp.call)
          .catch(async (error: unknown) => {
            pending = undefined;
            await closeFailedHandshake();
            throw error;
          });
        return pending;
      },
    },
    close: async () => {
      const closers = cleanups.splice(0).reverse();
      for (const cleanup of closers) await cleanup();
    },
  };
};

const parseJson = (stdout: string): unknown | undefined => {
  const document = stdout.trim();
  if (document.length === 0) return undefined;
  try {
    return JSON.parse(document) as unknown;
  } catch {
    return undefined;
  }
};

/** Reuse CLI compilation without overriding caller-selected cache or coverage. */
export const cliCompileCacheEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
  compileCache?: string,
): NodeJS.ProcessEnv => ({
  ...(compileCache === undefined || environment?.NODE_V8_COVERAGE !== undefined
    ? {}
    : { NODE_COMPILE_CACHE: compileCache }),
  ...environment,
});

/** Create a compiled CLI driver backed by the supplied process registry. */
export const createTestCli = (
  processes: TestProcesses,
  compileCache?: string,
): TestCli => ({
  run: async ({
    arguments: arguments_,
    cwd,
    environment,
    input,
    timeoutMs,
  }) => {
    const result = await processes.run(
      process.execPath,
      [resolve("scripts/rea.mjs"), ...arguments_],
      {
        cwd: cwd ?? process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          // Native Windows APIs need the system root and a writable temporary
          // directory even when the command's application environment is empty.
          ...(process.platform === "win32"
            ? {
                SystemRoot: process.env.SystemRoot,
                TEMP: tmpdir(),
                TMP: tmpdir(),
              }
            : {}),
          ...cliCompileCacheEnvironment(environment, compileCache),
        },
        ...(input === undefined ? {} : { input }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    );
    return { ...result, json: parseJson(result.stdout) };
  },
});

/** Vitest API extended with an owned process registry and compiled CLI driver. */
export const cliTest = processTest.extend<{
  $test: { cli: TestCli };
  $file: { mcpSession: FileMcpSession };
  $worker: { cliCompileCache: string };
}>({
  cliCompileCache: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
    async ({}, use) => {
      const workspace = await createTestWorkspace("rea-cli-compile-cache-");
      try {
        await use(workspace.path("node-compile"));
      } finally {
        await removeTestWorkspace(workspace.root);
      }
    },
    { scope: "worker" },
  ],
  mcpSession: [
    async ({ cliCompileCache }, use) => {
      const opened = createFileMcpSession(cliCompileCache);
      try {
        await use(opened.session);
      } finally {
        await opened.close();
      }
    },
    { scope: "file" },
  ],
  cli: async ({ processes, cliCompileCache, mcpSession }, use) => {
    const cli = createTestCli(processes, cliCompileCache);
    await use({
      ...cli,
      sharedMcpCall: () => mcpSession.call(),
    });
  },
});
