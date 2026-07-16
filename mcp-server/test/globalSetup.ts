import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The e2e suite runs against a LIVE, self-hosted Convex backend (see the "End
// to end tests" section of README.md). This global setup:
//   1. Resets the world (testing:wipeAllTables + init) via the Convex CLI.
//   2. Spawns the MCP server on a dedicated test port pointed at that backend.
//   3. Tears the server down afterward.

const MCP_DIR = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const PROJECT_ROOT = path.resolve(MCP_DIR, '..');

export const TEST_MCP_PORT = Number(process.env.TEST_MCP_PORT || 3990);
export const TEST_MCP_URL = `http://127.0.0.1:${TEST_MCP_PORT}/mcp`;
const CONVEX_URL = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL || 'http://127.0.0.1:3210';

let server: ChildProcess | undefined;

function convexRun(fn: string) {
  try {
    execFileSync('npx', ['convex', 'run', fn], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      env: process.env,
    });
  } catch (e: any) {
    const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message || '').trim();
    throw new Error(
      `Failed to run Convex function '${fn}'. Is the self-hosted backend up and deployed?\n` +
        `Run: ./mcp-server/scripts/setup-e2e-backend.sh\n\n${detail}`,
    );
  }
}

async function waitForHealth(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`MCP server did not become healthy at ${url} within ${timeoutMs}ms`);
}

export async function setup() {
  // Fresh, empty world for a deterministic run. convexRun surfaces a helpful
  // message (pointing at setup-e2e-backend.sh) if the backend isn't reachable.
  console.log('[e2e] resetting world (wipeAllTables + init)…');
  convexRun('testing:wipeAllTables');
  convexRun('init');

  // Boot the MCP server on the test port.
  console.log(`[e2e] starting MCP server on port ${TEST_MCP_PORT}…`);
  server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: MCP_DIR,
    env: { ...process.env, PORT: String(TEST_MCP_PORT), CONVEX_URL },
    stdio: 'inherit',
  });
  await waitForHealth(`http://127.0.0.1:${TEST_MCP_PORT}/health`);
  console.log('[e2e] MCP server is up.');
}

export async function teardown() {
  if (server && !server.killed) {
    server.kill('SIGTERM');
  }
}
