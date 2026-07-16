import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A thin test-side wrapper around an MCP client connected to the AI Town MCP
// server. One TownAgent === one MCP session === one player in the town.
export class TownAgent {
  private client: Client;
  playerId!: string;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(url: string): Promise<TownAgent> {
    const client = new Client({ name: 'e2e-test', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    return new TownAgent(client);
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result: any = await this.client.callTool({ name, arguments: args });
    const text = (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
    if (result.isError) {
      throw new Error(`Tool ${name} failed: ${text}`);
    }
    return text;
  }

  private async callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return JSON.parse(await this.call(name, args));
  }

  async join(opts: { name: string; character?: string; identity?: string }): Promise<string> {
    const res = await this.callJson('join_town', opts);
    this.playerId = res.playerId;
    return res.playerId;
  }

  observe(): Promise<AgentView> {
    return this.callJson('observe');
  }

  move(x: number, y: number) {
    return this.call('move', { x, y });
  }

  invite(playerId: string): Promise<{ conversationId: string }> {
    return this.callJson('invite', { playerId });
  }

  acceptInvite(conversationId?: string) {
    return this.call('accept_invite', conversationId ? { conversationId } : {});
  }

  rejectInvite(conversationId?: string) {
    return this.call('reject_invite', conversationId ? { conversationId } : {});
  }

  say(text: string) {
    return this.call('say', { text });
  }

  leaveConversation() {
    return this.call('leave_conversation');
  }

  leaveTown() {
    return this.call('leave_town');
  }

  async close() {
    await this.client.close();
  }
}

export type AgentView = {
  present: boolean;
  self?: {
    id: string;
    name: string;
    position: { x: number; y: number };
    moving: boolean;
  };
  mapDimensions?: { width: number; height: number };
  players: Array<{
    id: string;
    name: string;
    position: { x: number; y: number };
    distance: number;
    inConversation?: string;
  }>;
  invites: Array<{ conversationId: string; fromPlayerId?: string; fromPlayerName: string }>;
  conversation: null | {
    id: string;
    myStatus: string;
    otherPlayerId?: string;
    otherPlayerName: string;
    otherStatus?: string;
    numMessages: number;
    messages: Array<{ author: string; authorName: string; text: string; isSelf: boolean }>;
  };
};

// Poll `fn` until it returns a truthy value or the timeout elapses.
export async function waitFor<T>(
  fn: () => Promise<T> | T,
  opts: { timeout?: number; interval?: number; message?: string } = {},
): Promise<Exclude<T, false | null | undefined | 0 | ''>> {
  const { timeout = 30_000, interval = 400, message = 'condition' } = opts;
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last as Exclude<T, false | null | undefined | 0 | ''>;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out after ${timeout}ms waiting for: ${message} (last=${JSON.stringify(last)})`);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
