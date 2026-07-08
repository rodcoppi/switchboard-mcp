// Spike 0.4 do PRD (secao 16): mini servidor MCP Streamable HTTP em modo STATEFUL.
// Prova o risco R2: transporte MCP HTTP local funcionando com multiplas sessoes de Claude Code.
// SDK: @modelcontextprotocol/sdk 1.29.x (API confirmada contra node_modules).

import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// Decisao D6 do PRD: bind EXCLUSIVAMENTE em 127.0.0.1, hard-coded e nao configuravel.
// Qualquer mensagem entregue a um agente vira input executavel com acesso ao filesystem;
// expor este servidor na rede equivale a RCE de brinde. Nao mude isto.
const HOST = "127.0.0.1";
const PORT = 4578;

// Modo stateful: um transport (e um McpServer) por sessao MCP, reusado via header mcp-session-id.
const transports = new Map<string, StreamableHTTPServerTransport>();

function buildServer(): McpServer {
  const server = new McpServer({ name: "spike-mcp-http", version: "0.0.1" });

  // Uma unica tool "ping", sem input, que responde "pong".
  server.registerTool(
    "ping",
    { description: "Responds with 'pong'. Use it to verify the spike MCP server is reachable." },
    async () => {
      console.log(`[spike] ping called at ${new Date().toISOString()}`);
      return { content: [{ type: "text", text: "pong" }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Um unico handler para POST/GET/DELETE em /mcp (o transport diferencia os metodos):
// POST = mensagens JSON-RPC; GET = stream SSE server->client; DELETE = encerramento de sessao.
const mcpHandler = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    // Sessao existente: reusar o transport correspondente.
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    // Sem session id + request de initialize: criar sessao nova.
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          // Debugabilidade > elegancia: logar toda sessao criada.
          console.log(`[spike] session initialized: ${id}`);
          transports.set(id, transport);
        },
        onsessionclosed: (id) => {
          console.log(`[spike] session closed by client (DELETE): ${id}`);
        },
      });

      // Limpeza PARCIAL: onclose so dispara em DELETE explicito do cliente ou close() do
      // servidor. Cliente que morre sem DELETE (SIGKILL, crash, claude -p que simplesmente
      // termina) deixa a entrada orfa no Map para sempre. Suficiente para o spike; na Phase 2
      // e obrigatorio expirar sessoes por inatividade (ver spikes/NOTES.md, achado 4).
      transport.onclose = () => {
        if (transport.sessionId) {
          console.log(`[spike] transport closed, cleaning up session: ${transport.sessionId}`);
          transports.delete(transport.sessionId);
        }
      };

      await buildServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Session id desconhecido (ex.: servidor reiniciou e perdeu o estado em memoria).
    if (sessionId) {
      console.log(`[spike] unknown session id rejected (404): ${sessionId}`);
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    }

    // Sem session id e nao e initialize: request malformado.
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
      id: null,
    });
  } catch (err) {
    console.error("[spike] error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

app.post("/mcp", mcpHandler);
app.get("/mcp", mcpHandler);
app.delete("/mcp", mcpHandler);

// Body JSON malformado estoura DENTRO do express.json() (middleware), ANTES do mcpHandler —
// o try/catch do handler nunca ve esse erro. Sem isto, o Express devolve a pagina de erro
// default em HTML (fora do envelope JSON-RPC) e loga um stack trace de 10 linhas por typo
// de cliente. Erro de transporte JSON-RPC correto: -32700 Parse error, sempre em JSON.
// (Debugabilidade > elegancia: no Hub da Phase 2 isto e obrigatorio — api.ts exige erros em JSON.)
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && !res.headersSent) {
    console.warn(`[spike] malformed JSON body rejected (-32700): ${(err as Error).message}`);
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    return;
  }
  next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`[spike] MCP Streamable HTTP (stateful) escutando em http://${HOST}:${PORT}/mcp`);
});
