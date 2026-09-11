// n8n Supervisor MCP Adapter
// Exposes ONE tool, "send_supervisor_command", which forwards a command
// to your n8n Supervisor webhook and returns its response.
//
// Required environment variables (set these on your host, NEVER in code):
//   SUPERVISOR_WEBHOOK_URL   e.g. https://your-n8n-host/webhook/openai-supervisor-loop
//   SUPERVISOR_AUTH_HEADER_NAME   e.g. "Authorization" or your custom header name
//   SUPERVISOR_AUTH_HEADER_VALUE  the secret value for that header (the "ChatGPT Bridge Auth" key)
//   PORT (optional, defaults to 3000)

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const {
  SUPERVISOR_WEBHOOK_URL,
  SUPERVISOR_AUTH_HEADER_NAME,
  SUPERVISOR_AUTH_HEADER_VALUE,
  PORT = 3000,
} = process.env;

if (!SUPERVISOR_WEBHOOK_URL || !SUPERVISOR_AUTH_HEADER_NAME || !SUPERVISOR_AUTH_HEADER_VALUE) {
  console.error(
    "Missing required env vars: SUPERVISOR_WEBHOOK_URL, SUPERVISOR_AUTH_HEADER_NAME, SUPERVISOR_AUTH_HEADER_VALUE"
  );
  process.exit(1);
}

function buildServer() {
  const server = new McpServer({
    name: "n8n-supervisor-adapter",
    version: "1.0.0",
  });

  server.registerTool(
    "send_supervisor_command",
    {
      title: "Send command to n8n Supervisor",
      description:
        "Sends a single text command to the n8n Supervisor workflow and returns its response. Use this whenever the user asks you to run, check, or relay a command to their n8n Supervisor (e.g. 'STATUS').",
      inputSchema: {
        command: z.string().describe("The command text to send to the Supervisor, e.g. 'STATUS'"),
      },
    },
    async ({ command }) => {
      try {
        const resp = await fetch(SUPERVISOR_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [SUPERVISOR_AUTH_HEADER_NAME]: SUPERVISOR_AUTH_HEADER_VALUE,
          },
          body: JSON.stringify({ command }),
        });

        const text = await resp.text();

        if (!resp.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Supervisor returned HTTP ${resp.status}: ${text}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to reach Supervisor: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless mode: a fresh server+transport per request is simplest and
// avoids session-management complexity for a single-tool adapter.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE on /mcp are not needed in stateless mode
app.get("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`n8n Supervisor MCP adapter listening on port ${PORT}`);
});
