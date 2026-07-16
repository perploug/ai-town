import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agentView,
  getDefaultWorld,
  heartbeatWorld,
  sendInput,
  writeMessage,
  type WorldHandle,
} from './convex.js';

// Valid character sprite names accepted by the `join` input (data/characters.ts).
const CHARACTERS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

// One session === one connected external agent === one player in the town.
type Session = {
  token: string;
  world?: WorldHandle;
  playerId?: string;
  name?: string;
  heartbeat?: ReturnType<typeof setInterval>;
};

// Persistent registry: clientToken → live player info.
// Survives individual transport connections so agents can reconnect without
// spawning duplicate characters.
type RegistryEntry = { playerId: string; world: WorldHandle };
const registry = new Map<string, RegistryEntry>();

function text(value: unknown) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text: body }] };
}

function errorText(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// Resolve the caller's current conversation from a fresh observation.
async function requireConversation(session: Session, view: any): Promise<string | undefined> {
  return view?.conversation?.id;
}

export function createSession(): Session {
  return { token: `mcp-agent:${randomUUID()}` };
}

export function buildMcpServer(session: Session): McpServer {
  const server = new McpServer(
    { name: 'ai-town', version: '0.1.0' },
    {
      instructions:
        'AI Town is a spatial chatroom. Call join_town first to enter, then loop: observe → ' +
        'decide → act (move / invite / accept_invite / say / leave_conversation). Conversations ' +
        'require walking close to the other player; keep calling observe until your status and ' +
        "the other player's status are both 'participating' before you say something.",
    },
  );

  const ensureJoined = (): { world: WorldHandle; playerId: string } | null => {
    if (!session.world || !session.playerId) return null;
    return { world: session.world, playerId: session.playerId };
  };

  server.tool(
    'join_town',
    'Enter the town as a character. Must be called before any other tool. ' +
      'On your first call, omit clientToken — you will receive one in the response. ' +
      'IMPORTANT: persist the returned clientToken and pass it on every subsequent ' +
      'join_town call so the server can reconnect you to your existing character ' +
      'instead of spawning a duplicate.',
    {
      name: z.string().describe('Display name for your character, e.g. "Ada".'),
      identity: z
        .string()
        .optional()
        .describe('A short description / personality shown to others and in the UI.'),
      character: z
        .enum(CHARACTERS as [string, ...string[]])
        .optional()
        .describe('Sprite to use (f1–f8). Defaults to a random one.'),
      clientToken: z
        .string()
        .optional()
        .describe(
          'Your persistent identity token from a previous join_town call. ' +
            'Always provide this if you have one — it prevents duplicate characters.',
        ),
    },
    async ({ name, identity, character, clientToken }) => {
      if (session.playerId) {
        return errorText(`Already joined as player ${session.playerId}. Call leave_town first.`);
      }

      // If the agent supplies a known token, try to reconnect to the existing player.
      if (clientToken) {
        const entry = registry.get(clientToken);
        if (entry) {
          const view = await agentView(entry.world.worldId, entry.playerId);
          if (view?.present) {
            // Player is still alive — reattach this session to it.
            session.token = clientToken;
            session.world = entry.world;
            session.playerId = entry.playerId;
            session.name = name;
            session.heartbeat = setInterval(() => {
              sendInput(entry.world, 'keepAlive', { playerId: entry.playerId }).catch(() => {});
              heartbeatWorld(entry.world.worldId).catch(() => {});
            }, HEARTBEAT_INTERVAL_MS);
            console.log(`Reconnected token ${clientToken} → player ${entry.playerId}`);
            return text({
              playerId: entry.playerId,
              clientToken,
              reconnected: true,
              message: `Reconnected as ${name}. Use observe to look around.`,
            });
          }
          // Player was reaped — fall through and re-join with the same token.
          registry.delete(clientToken);
          console.log(`Token ${clientToken} had reaped player — re-joining.`);
        }
        // Use the supplied token as our stable identity so the character keeps
        // the same tokenIdentifier across reconnections.
        session.token = clientToken;
      }

      const world = await getDefaultWorld();
      await heartbeatWorld(world.worldId);
      const chosen = character ?? CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
      const value = await sendInput(world, 'join', {
        name,
        character: chosen,
        description: identity ?? `${name} is an external agent visiting the town.`,
        tokenIdentifier: session.token,
      });
      const playerId = value?.playerId;
      if (!playerId) {
        return errorText('Join did not return a playerId.');
      }
      session.world = world;
      session.playerId = playerId;
      session.name = name;
      registry.set(session.token, { playerId, world });

      session.heartbeat = setInterval(() => {
        sendInput(world, 'keepAlive', { playerId }).catch(() => {});
        heartbeatWorld(world.worldId).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);

      return text({
        playerId,
        clientToken: session.token,
        reconnected: false,
        message:
          `Joined as ${name}. ` +
          `IMPORTANT: save your clientToken ("${session.token}") and pass it ` +
          `as clientToken on every future join_town call to avoid duplicate characters.`,
      });
    },
  );

  server.tool(
    'observe',
    'Look around: your position, nearby players (sorted by distance), pending conversation invites, and your current conversation with recent messages.',
    {},
    async () => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      const view = await agentView(joined.world.worldId, joined.playerId);
      if (!view?.present) {
        return errorText('Your player is no longer present in the world.');
      }
      return text(view);
    },
  );

  server.tool(
    'move',
    'Walk toward a tile. Coordinates are integer tile positions within the map (see mapDimensions from observe). The engine handles pathfinding.',
    {
      x: z.number().int().describe('Destination tile x.'),
      y: z.number().int().describe('Destination tile y.'),
    },
    async ({ x, y }) => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      await sendInput(joined.world, 'moveTo', {
        playerId: joined.playerId,
        destination: { x, y },
      });
      return text(`Heading to (${x}, ${y}).`);
    },
  );

  server.tool(
    'invite',
    'Invite another player to a conversation. Use observe to find nearby playerIds. Returns the conversationId.',
    {
      playerId: z.string().describe('The player you want to talk to.'),
    },
    async ({ playerId }) => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      const conversationId = await sendInput(joined.world, 'startConversation', {
        playerId: joined.playerId,
        invitee: playerId,
      });
      return text({
        conversationId,
        message: `Invited ${playerId}. Walk over (the engine routes you) and keep observing until both statuses are 'participating'.`,
      });
    },
  );

  server.tool(
    'accept_invite',
    'Accept a pending conversation invite. If conversationId is omitted, accepts your first pending invite.',
    {
      conversationId: z.string().optional().describe('Which invite to accept.'),
    },
    async ({ conversationId }) => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      let convId = conversationId;
      if (!convId) {
        const view = await agentView(joined.world.worldId, joined.playerId);
        convId = view?.invites?.[0]?.conversationId;
        if (!convId) return errorText('No pending invites to accept.');
      }
      await sendInput(joined.world, 'acceptInvite', {
        playerId: joined.playerId,
        conversationId: convId,
      });
      return text(`Accepted invite ${convId}. Walk over and observe until you're participating.`);
    },
  );

  server.tool(
    'reject_invite',
    'Reject a pending conversation invite. If conversationId is omitted, rejects your first pending invite.',
    {
      conversationId: z.string().optional().describe('Which invite to reject.'),
    },
    async ({ conversationId }) => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      let convId = conversationId;
      if (!convId) {
        const view = await agentView(joined.world.worldId, joined.playerId);
        convId = view?.invites?.[0]?.conversationId;
        if (!convId) return errorText('No pending invites to reject.');
      }
      await sendInput(joined.world, 'rejectInvite', {
        playerId: joined.playerId,
        conversationId: convId,
      });
      return text(`Rejected invite ${convId}.`);
    },
  );

  server.tool(
    'say',
    "Send a message in your current conversation. You should be 'participating' first (check observe).",
    {
      text: z.string().describe('What to say.'),
    },
    async ({ text: message }) => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      const view = await agentView(joined.world.worldId, joined.playerId);
      const conversationId = await requireConversation(session, view);
      if (!conversationId) {
        return errorText('You are not in a conversation. Invite someone or accept an invite first.');
      }
      await writeMessage({
        worldId: joined.world.worldId,
        conversationId,
        messageUuid: randomUUID(),
        playerId: joined.playerId,
        text: message,
      });
      return text('Message sent.');
    },
  );

  server.tool(
    'leave_conversation',
    'Leave your current conversation.',
    {},
    async () => {
      const joined = ensureJoined();
      if (!joined) return errorText('You are not in the town. Call join_town first.');
      const view = await agentView(joined.world.worldId, joined.playerId);
      const conversationId = await requireConversation(session, view);
      if (!conversationId) return errorText('You are not in a conversation.');
      await sendInput(joined.world, 'leaveConversation', {
        playerId: joined.playerId,
        conversationId,
      });
      return text('Left the conversation.');
    },
  );

  server.tool('leave_town', 'Leave the town entirely, removing your character.', {}, async () => {
    const joined = ensureJoined();
    if (!joined) return errorText('You are not in the town.');
    await sendInput(joined.world, 'leave', { playerId: joined.playerId });
    stopHeartbeat(session);
    registry.delete(session.token);
    session.playerId = undefined;
    session.world = undefined;
    return text('Left the town. Your clientToken is no longer valid; call join_town without one to get a new identity.');
  });

  return server;
}

export function stopHeartbeat(session: Session) {
  if (session.heartbeat) {
    clearInterval(session.heartbeat);
    session.heartbeat = undefined;
  }
}

// Best-effort cleanup when a session's transport closes.
// We do NOT remove the registry entry here — the agent may reconnect with its
// clientToken and resume the same player.  The registry entry is only cleared
// when the player is confirmed gone (leave_town or reap detected on reconnect).
export async function disposeSession(session: Session) {
  stopHeartbeat(session);
  if (session.world && session.playerId) {
    try {
      await sendInput(session.world, 'leave', { playerId: session.playerId });
    } catch {
      // The engine may already have reaped an idle player; ignore.
    }
    registry.delete(session.token);
    session.playerId = undefined;
  }
}
