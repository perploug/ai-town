import { v } from 'convex/values';
import { internal } from './_generated/api';
import { MutationCtx, mutation } from './_generated/server';
import * as map from '../data/gentle';
import { createEngine } from './aiTown/main';
import { ENGINE_ACTION_DURATION } from './constants';
import { detectMismatchedLLMProvider } from './util/llm';

// Agents are no longer seeded statically from `data/characters.ts`. The town
// starts empty and is populated by external agents that connect over the MCP
// endpoint (see `mcp-server/`). This mutation just ensures a running, empty
// default world exists.
const init = mutation({
  args: {
    // Kept for backwards-compatibility with tooling/docs that pass it; ignored.
    numAgents: v.optional(v.number()),
  },
  handler: async (ctx) => {
    detectMismatchedLLMProvider();
    const { worldStatus, engine } = await getOrCreateDefaultWorld(ctx);
    if (worldStatus.status !== 'running') {
      console.warn(
        `Engine ${engine._id} is not active! Run "npx convex run testing:resume" to restart it.`,
      );
      return;
    }
    console.log(
      `Default world ${worldStatus.worldId} is running. Agents join via the MCP endpoint.`,
    );
  },
});
export default init;

async function getOrCreateDefaultWorld(ctx: MutationCtx) {
  const now = Date.now();

  let worldStatus = await ctx.db
    .query('worldStatus')
    .filter((q) => q.eq(q.field('isDefault'), true))
    .unique();
  if (worldStatus) {
    const engine = (await ctx.db.get(worldStatus.engineId))!;
    return { worldStatus, engine };
  }

  const engineId = await createEngine(ctx);
  const engine = (await ctx.db.get(engineId))!;
  const worldId = await ctx.db.insert('worlds', {
    nextId: 0,
    agents: [],
    conversations: [],
    players: [],
  });
  const worldStatusId = await ctx.db.insert('worldStatus', {
    engineId: engineId,
    isDefault: true,
    lastViewed: now,
    status: 'running',
    worldId: worldId,
  });
  worldStatus = (await ctx.db.get(worldStatusId))!;
  await ctx.db.insert('maps', {
    worldId,
    width: map.mapwidth,
    height: map.mapheight,
    tileSetUrl: map.tilesetpath,
    tileSetDimX: map.tilesetpxw,
    tileSetDimY: map.tilesetpxh,
    tileDim: map.tiledim,
    bgTiles: map.bgtiles,
    objectTiles: map.objmap,
    animatedSprites: map.animatedsprites,
  });
  await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
    worldId,
    generationNumber: engine.generationNumber,
    maxDuration: ENGINE_ACTION_DURATION,
  });
  return { worldStatus, engine };
}
