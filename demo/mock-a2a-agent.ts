/**
 * Mock A2A Agent Server
 *
 * A minimal A2A-protocol-compatible HTTP server for testing `a2a-plugin-runtime.ts`.
 * Implements:
 *   GET  /.well-known/agent.json   → agent card
 *   POST /                         → tasks/send, tasks/get, tasks/cancel
 *
 * Run with:
 *   bun run mock-a2a-agent.ts          # default port 4000
 *   PORT=4001 bun run mock-a2a-agent.ts
 */

const PORT = Number(process.env['MOCK_A2A_PORT']) || 4000;

type TaskState = 'submitted' | 'working' | 'completed' | 'canceled' | 'failed';

interface Task {
  id: string;
  sessionId?: string | null;
  status: { state: TaskState; timestamp: string };
  history: Array<{ role: 'user' | 'agent'; parts: Array<{ type: 'text'; text: string }> }>;
  artifacts: Array<{ name: string; parts: Array<{ type: 'text'; text: string }> }>;
  metadata?: Record<string, unknown>;
}

const tasks = new Map<string, Task>();

const AGENT_CARD = {
  name: 'Mock A2A Echo Agent',
  description: 'A minimal echo agent for testing the a2a-plugin-runtime demo.',
  url: `http://localhost:${PORT}`,
  version: '1.0.0',
  skills: [
    {
      id: 'echo',
      name: 'Echo',
      description: 'Echoes back user messages.',
    },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
};

function rpcOk(id: string | number | null, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Agent card
  if (url.pathname === '/.well-known/agent.json' && req.method === 'GET') {
    return Response.json(AGENT_CARD);
  }

  // JSON-RPC endpoint
  if (url.pathname === '/' && req.method === 'POST') {
    let body: { jsonrpc: string; id: string | number | null; method: string; params?: Record<string, unknown> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return rpcError(null, -32700, 'Parse error');
    }

    const { id, method, params = {} } = body;

    if (method === 'tasks/send') {
      const taskId = (params['id'] as string) ?? crypto.randomUUID();
      const sessionId = (params['sessionId'] as string | null) ?? null;
      const message = params['message'] as { role: string; parts: Array<{ type: string; text?: string }> };
      const userText =
        message?.parts?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('') ?? '';

      // Simulate async processing: create task as 'completed' immediately (echo bot)
      const task: Task = {
        id: taskId,
        sessionId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        history: [
          { role: 'user', parts: [{ type: 'text', text: userText }] },
          { role: 'agent', parts: [{ type: 'text', text: `Echo from A2A agent: ${userText}` }] },
        ],
        artifacts: [
          {
            name: 'reply',
            parts: [{ type: 'text', text: `Echo from A2A agent: ${userText}` }],
          },
        ],
        metadata: { sessionKey: sessionId },
      };

      tasks.set(taskId, task);
      console.info(`[mock-a2a] tasks/send: id=${taskId} text="${userText}"`);
      return rpcOk(id, task);
    }

    if (method === 'tasks/get') {
      const taskId = params['id'] as string;
      const task = tasks.get(taskId);
      if (!task) return rpcError(id, -32001, `Task not found: ${taskId}`);
      console.info(`[mock-a2a] tasks/get: id=${taskId} state=${task.status.state}`);
      return rpcOk(id, task);
    }

    if (method === 'tasks/cancel') {
      const taskId = params['id'] as string;
      const task = tasks.get(taskId);
      if (!task) return rpcError(id, -32001, `Task not found: ${taskId}`);
      task.status = { state: 'canceled', timestamp: new Date().toISOString() };
      console.info(`[mock-a2a] tasks/cancel: id=${taskId}`);
      return rpcOk(id, { id: taskId, status: task.status });
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  return new Response('Not Found', { status: 404 });
}

const server = Bun.serve({ port: PORT, fetch: handleRequest });
console.info(`[mock-a2a] running on http://localhost:${PORT}`);
export default server;
