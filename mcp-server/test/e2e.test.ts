import { afterEach, describe, expect, it } from 'vitest';
import { TownAgent, waitFor, type AgentView } from './helpers.js';
import { TEST_MCP_URL } from './globalSetup.js';

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Track agents created in each test so we can always disconnect + leave.
const open: TownAgent[] = [];
async function newAgent(opts: { name: string; character?: string; identity?: string }) {
  const agent = await TownAgent.connect(TEST_MCP_URL);
  await agent.join(opts);
  open.push(agent);
  return agent;
}

afterEach(async () => {
  for (const agent of open.splice(0)) {
    try {
      await agent.leaveTown();
    } catch {
      /* may already be gone */
    }
    await agent.close();
  }
});

// Walk `mover` until it is within `within` tiles of the target player, retrying
// the destination each poll (robust to obstacles / a moving target).
async function approach(mover: TownAgent, targetId: string, within = 1.25, timeout = 70_000) {
  await waitFor(
    async () => {
      const view = await mover.observe();
      const target = view.players.find((p) => p.id === targetId);
      if (!target || !view.self) return false;
      if (distance(view.self.position, target.position) <= within) return true;
      const tx = Math.round(target.position.x) + 1;
      const ty = Math.round(target.position.y);
      await mover.move(tx, ty).catch(() => {});
      return false;
    },
    { timeout, interval: 1500, message: `approach ${targetId}` },
  );
}

describe('AI Town MCP e2e', () => {
  it('joins the town and appears to other agents (multi-session)', async () => {
    const alice = await newAgent({ name: 'Alice', character: 'f1', identity: 'curious' });
    const bob = await newAgent({ name: 'Bob', character: 'f2', identity: 'friendly' });

    expect(alice.playerId).toBeTruthy();
    expect(bob.playerId).toBeTruthy();
    expect(alice.playerId).not.toEqual(bob.playerId);

    // Each agent sees itself present, with map dimensions.
    const aliceView = await alice.observe();
    expect(aliceView.present).toBe(true);
    expect(aliceView.self?.name).toBe('Alice');
    expect(aliceView.mapDimensions?.width).toBeGreaterThan(0);

    // Alice sees Bob and vice-versa.
    const sawBob = await waitFor(
      async () => (await alice.observe()).players.find((p) => p.id === bob.playerId),
      { message: 'Alice sees Bob' },
    );
    expect(sawBob.name).toBe('Bob');

    const sawAlice = await waitFor(
      async () => (await bob.observe()).players.find((p) => p.id === alice.playerId),
      { message: 'Bob sees Alice' },
    );
    expect(sawAlice.name).toBe('Alice');
  });

  it('moves to a destination', async () => {
    const walker = await newAgent({ name: 'Walker', character: 'f3' });
    const start = (await walker.observe()).self!.position;

    // Aim for a tile diagonally offset from the start, clamped to the map.
    const { width, height } = (await walker.observe()).mapDimensions!;
    const target = {
      x: Math.min(width - 2, Math.max(1, Math.round(start.x) + (start.x < width / 2 ? 5 : -5))),
      y: Math.min(height - 2, Math.max(1, Math.round(start.y) + (start.y < height / 2 ? 5 : -5))),
    };
    await walker.move(target.x, target.y);

    const moved = await waitFor(
      async () => {
        const pos = (await walker.observe()).self!.position;
        return distance(pos, start) > 0.5 ? pos : false;
      },
      { timeout: 40_000, message: 'walker changed position' },
    );
    expect(distance(moved, start)).toBeGreaterThan(0.5);
  });

  it('runs a full conversation: invite → accept → participate → talk → leave', async () => {
    const ada = await newAgent({ name: 'Ada', character: 'f4', identity: 'mathematician' });
    const grace = await newAgent({ name: 'Grace', character: 'f5', identity: 'engineer' });

    // Get Ada next to Grace before inviting (players in a conversation can't move).
    await approach(ada, grace.playerId);

    const { conversationId } = await ada.invite(grace.playerId);
    expect(conversationId).toBeTruthy();

    // Grace should see the pending invite, then accept it.
    const invite = await waitFor(
      async () => (await grace.observe()).invites.find((i) => i.conversationId === conversationId),
      { message: 'Grace sees invite' },
    );
    expect(invite.fromPlayerName).toBe('Ada');
    await grace.acceptInvite(conversationId);

    // Both walk together and transition to "participating".
    const bothParticipating = async (view: AgentView) =>
      view.conversation?.id === conversationId &&
      view.conversation.myStatus === 'participating' &&
      view.conversation.otherStatus === 'participating';

    await waitFor(async () => bothParticipating(await ada.observe()), {
      timeout: 60_000,
      message: 'Ada participating',
    });
    await waitFor(async () => bothParticipating(await grace.observe()), {
      message: 'Grace participating',
    });

    // Exchange messages; each side should read both.
    await ada.say('Hello Grace, want to talk about algorithms?');
    await grace.say('Hi Ada! Absolutely, I love a good invariant.');

    const hasBothMessages = (view: AgentView) => {
      const texts = (view.conversation?.messages ?? []).map((m) => m.text);
      return texts.some((t) => t.includes('algorithms')) && texts.some((t) => t.includes('invariant'));
    };
    await waitFor(async () => hasBothMessages(await ada.observe()), { message: 'Ada reads both messages' });
    const graceFinal = await waitFor(async () => {
      const v = await grace.observe();
      return hasBothMessages(v) ? v : false;
    }, { message: 'Grace reads both messages' });

    // Message authorship is attributed correctly.
    const adaMsg = graceFinal.conversation!.messages.find((m) => m.text.includes('algorithms'))!;
    expect(adaMsg.authorName).toBe('Ada');
    expect(adaMsg.isSelf).toBe(false);

    // Ada leaves; the conversation ends for both.
    await ada.leaveConversation();
    await waitFor(async () => ((await grace.observe()).conversation === null ? true : false), {
      message: 'conversation ended for Grace',
    });
    expect((await ada.observe()).conversation).toBeNull();
  });

  it('leaves the town and disappears from the world', async () => {
    const observer = await newAgent({ name: 'Observer', character: 'f6' });
    const ghost = await TownAgent.connect(TEST_MCP_URL);
    await ghost.join({ name: 'Ghost', character: 'f7' });

    await waitFor(
      async () => (await observer.observe()).players.find((p) => p.id === ghost.playerId),
      { message: 'observer sees ghost' },
    );

    await ghost.leaveTown();
    await ghost.close();

    await waitFor(
      async () =>
        (await observer.observe()).players.every((p) => p.id !== ghost.playerId) ? true : false,
      { message: 'ghost removed from world' },
    );
  });
});
