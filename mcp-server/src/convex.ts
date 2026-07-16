import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

// We reference Convex functions by their string name ("module:export") via
// makeFunctionReference so this standalone package doesn't need the app's
// generated `convex/_generated/api` types.
const fns = {
  defaultWorldStatus: makeFunctionReference<'query'>('world:defaultWorldStatus'),
  sendWorldInput: makeFunctionReference<'mutation'>('world:sendWorldInput'),
  inputStatus: makeFunctionReference<'query'>('aiTown/main:inputStatus'),
  writeMessage: makeFunctionReference<'mutation'>('messages:writeMessage'),
  heartbeatWorld: makeFunctionReference<'mutation'>('world:heartbeatWorld'),
  agentView: makeFunctionReference<'query'>('mcp:agentView'),
};

const CONVEX_URL = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
  throw new Error(
    'Set CONVEX_URL (or VITE_CONVEX_URL) to your AI Town Convex deployment URL, e.g. https://your-deployment.convex.cloud',
  );
}

// ConvexHttpClient is stateless per request, which is exactly what we want for
// many concurrent sessions and for polling input status.
const client = new ConvexHttpClient(CONVEX_URL);

export type WorldHandle = {
  worldId: string;
  engineId: string;
};

export async function getDefaultWorld(): Promise<WorldHandle> {
  const status: any = await client.query(fns.defaultWorldStatus, {});
  if (!status) {
    throw new Error(
      'No default world found. Bootstrap one with `npx convex run init` in the ai-town project.',
    );
  }
  return { worldId: status.worldId, engineId: status.engineId };
}

// Keep the world awake. AI Town stops "inactive" worlds (no viewer) after
// IDLE_WORLD_TIMEOUT via a cron; the browser normally heartbeats. With no
// browser, the MCP server must do it — this also restarts an already-inactive
// world, so it doubles as wake-on-connect.
export async function heartbeatWorld(worldId: string): Promise<void> {
  await client.mutation(fns.heartbeatWorld, { worldId });
}

// Insert an input and wait for the engine to process it, mirroring the
// browser's `waitForInput` (src/hooks/sendInput.ts) but with polling since the
// HTTP client has no subscriptions.
export async function sendInput(
  world: WorldHandle,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<any> {
  const inputId = await client.mutation(fns.sendWorldInput, {
    engineId: world.engineId,
    name,
    args,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result: any = await client.query(fns.inputStatus, { inputId });
    if (result !== null && result !== undefined) {
      if (result.kind === 'error') {
        throw new Error(result.message);
      }
      return result.value;
    }
    await sleep(250);
  }
  throw new Error(`Input '${name}' was not processed within ${timeoutMs}ms.`);
}

export async function writeMessage(args: {
  worldId: string;
  conversationId: string;
  messageUuid: string;
  playerId: string;
  text: string;
}): Promise<void> {
  await client.mutation(fns.writeMessage, args);
}

export async function agentView(worldId: string, playerId: string): Promise<any> {
  return await client.query(fns.agentView, { worldId, playerId });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
