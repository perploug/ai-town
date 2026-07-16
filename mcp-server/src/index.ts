import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, createSession, disposeSession } from './mcpServer.js';

const PORT = Number(process.env.PORT || 3939);
const HOST = process.env.HOST || '0.0.0.0';

// One transport + session per connected agent, keyed by MCP session id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

const app = express();
app.use(express.json({ limit: '4mb' }));

// Simple health check.
app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: Object.keys(transports).length });
});

// POST /mcp — client-to-server JSON-RPC messages.
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session. Send an initialize request first.' },
        id: null,
      });
      return;
    }

    // New session: create transport + a fresh McpServer bound to a new agent.
    const session = createSession();
    const server = buildMcpServer(session);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport!;
        console.log(`Session ${sid} initialized (${Object.keys(transports).length} active).`);
      },
    });

    transport.onclose = () => {
      const sid = transport!.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
      }
      console.log(`Session ${sid ?? '?'} closed (${Object.keys(transports).length} active).`);
      void disposeSession(session);
    };

    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — server-to-client SSE stream. DELETE /mcp — session teardown.
const handleSessionRequest = async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send('Invalid or missing session id.');
    return;
  }
  await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.listen(PORT, HOST, () => {
  console.log(`AI Town MCP server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`Convex deployment: ${process.env.CONVEX_URL || process.env.VITE_CONVEX_URL}`);
});
