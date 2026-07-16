import { v } from 'convex/values';
import { query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { distance } from './util/geometry';

// A single composite read that gives an externally-connected (MCP) agent
// everything it needs to decide its next action: where it is, who is nearby,
// the state of its current conversation, any pending invites, and the recent
// messages in that conversation. It intentionally overlaps with
// `world.worldState` + `world.gameDescriptions` + `messages.listMessages` but
// collapses them into one round-trip scoped to a single player.
export const agentView = query({
  args: {
    worldId: v.id('worlds'),
    playerId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`Invalid world ID: ${args.worldId}`);
    }

    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const descriptionByPlayer = new Map(descriptions.map((d) => [d.playerId, d]));

    const worldMap = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();

    const nameFor = (id: string) => descriptionByPlayer.get(id)?.name ?? 'unknown';

    const self = world.players.find((p) => p.id === args.playerId);
    if (!self) {
      // The player may not have been created yet (input still pending) or may
      // have already left. Let the client distinguish this from an error.
      return { present: false as const };
    }

    // Which conversation, if any, is each player in.
    const conversationOfPlayer = new Map<string, (typeof world.conversations)[number]>();
    for (const conversation of world.conversations) {
      for (const member of conversation.participants) {
        conversationOfPlayer.set(member.playerId, conversation);
      }
    }

    const selfDescription = descriptionByPlayer.get(self.id);
    const others = world.players
      .filter((p) => p.id !== self.id)
      .map((p) => {
        const conv = conversationOfPlayer.get(p.id);
        return {
          id: p.id,
          name: nameFor(p.id),
          description: descriptionByPlayer.get(p.id)?.description ?? '',
          character: descriptionByPlayer.get(p.id)?.character ?? '',
          isHuman: !!p.human,
          position: p.position,
          distance: distance(self.position, p.position),
          activity:
            p.activity && p.activity.until > Date.now() ? p.activity.description : undefined,
          inConversation: conv ? conv.id : undefined,
        };
      })
      .sort((a, b) => a.distance - b.distance);

    // Pending invitations addressed to us (someone else started a conversation
    // and we're still in the `invited` state).
    const invites = [];
    for (const conversation of world.conversations) {
      const me = conversation.participants.find((m) => m.playerId === self.id);
      if (me && me.status.kind === 'invited') {
        const inviter = conversation.participants.find((m) => m.playerId !== self.id);
        invites.push({
          conversationId: conversation.id,
          fromPlayerId: inviter?.playerId,
          fromPlayerName: inviter ? nameFor(inviter.playerId) : 'unknown',
        });
      }
    }

    // Our current conversation (if we're a participant of one).
    let conversation = null;
    const myConversation = conversationOfPlayer.get(self.id);
    if (myConversation) {
      const me = myConversation.participants.find((m) => m.playerId === self.id)!;
      const other = myConversation.participants.find((m) => m.playerId !== self.id);
      const rawMessages = await ctx.db
        .query('messages')
        .withIndex('conversationId', (q) =>
          q.eq('worldId', args.worldId).eq('conversationId', myConversation.id),
        )
        .collect();
      const messages = rawMessages.slice(-20).map((m) => ({
        author: m.author,
        authorName: nameFor(m.author),
        text: m.text,
        isSelf: m.author === self.id,
      }));
      conversation = {
        id: myConversation.id,
        creator: myConversation.creator,
        myStatus: me.status.kind,
        otherPlayerId: other?.playerId,
        otherPlayerName: other ? nameFor(other.playerId) : 'unknown',
        otherStatus: other?.status.kind,
        numMessages: myConversation.numMessages,
        someoneTyping: myConversation.isTyping
          ? {
              playerId: myConversation.isTyping.playerId,
              isSelf: myConversation.isTyping.playerId === self.id,
            }
          : undefined,
        messages,
      };
    }

    return {
      present: true as const,
      self: {
        id: self.id,
        name: selfDescription?.name ?? 'unknown',
        description: selfDescription?.description ?? '',
        character: selfDescription?.character ?? '',
        position: self.position,
        facing: self.facing,
        speed: self.speed,
        moving: !!self.pathfinding,
        activity:
          self.activity && self.activity.until > Date.now() ? self.activity.description : undefined,
      },
      mapDimensions: worldMap ? { width: worldMap.width, height: worldMap.height } : undefined,
      players: others,
      invites,
      conversation,
    };
  },
});
