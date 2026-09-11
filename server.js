// n8n Supervisor MCP Adapter
// Exposes:
//  - send_supervisor_command: forwards a command to your n8n Supervisor webhook
//  - READ-ONLY n8n API tools: list_workflows, get_workflow, list_executions,
//    get_execution — these only ever call GET on the n8n REST API.
//  - patch_node_parameter: a SCOPED write tool — changes exactly one
//    parameter on one existing node, dry-run by default, with a live
//    post-write verification read.
//
// Required environment variables (set these on your host, NEVER in code):
//   SUPERVISOR_WEBHOOK_URL   e.g. https://your-n8n-host/webhook/openai-supervisor-loop
//   SUPERVISOR_AUTH_HEADER_NAME   e.g. "Authorization" or your custom header name
//   SUPERVISOR_AUTH_HEADER_VALUE  the secret value for that header (the "ChatGPT Bridge Auth" key)
//   N8N_API_BASE_URL   e.g. https://your-n8n-host/api/v1
//   N8N_API_KEY        your n8n API key (read-only scope), used for list_workflows/get_workflow/list_executions/get_execution
//   PORT (optional, defaults to 3000)

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const {
  SUPERVISOR_WEBHOOK_URL,
  SUPERVISOR_AUTH_HEADER_NAME,
  SUPERVISOR_AUTH_HEADER_VALUE,
  N8N_API_BASE_URL,
  N8N_API_KEY,
  PORT = 3000,
} = process.env;

if (!SUPERVISOR_WEBHOOK_URL || !SUPERVISOR_AUTH_HEADER_NAME || !SUPERVISOR_AUTH_HEADER_VALUE) {
  console.error(
    "Missing required env vars: SUPERVISOR_WEBHOOK_URL, SUPERVISOR_AUTH_HEADER_NAME, SUPERVISOR_AUTH_HEADER_VALUE"
  );
  process.exit(1);
}

// n8n API tools are optional — only registered if these are set.
const N8N_API_ENABLED = Boolean(N8N_API_BASE_URL && N8N_API_KEY);

// Max characters of an execution's "data" payload to return before truncating.
const MAX_EXECUTION_DATA_CHARS = 15000;

async function n8nApiGet(path) {
  const url = `${N8N_API_BASE_URL.replace(/\/$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json",
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`n8n API GET ${path} returned HTTP ${resp.status}: ${text}`);
  }
  return text;
}

async function n8nApiPut(path, body) {
  const url = `${N8N_API_BASE_URL.replace(/\/$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`n8n API PUT ${path} returned HTTP ${resp.status}: ${text}`);
  }
  return text;
}

// Small helper: get/set a value inside node.parameters using a dot path,
// e.g. "url" or "options.timeout".
function getByPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}
function setByPath(obj, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  const target = parts.reduce((acc, key) => {
    if (acc[key] == null || typeof acc[key] !== "object") acc[key] = {};
    return acc[key];
  }, obj);
  target[last] = value;
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

  if (N8N_API_ENABLED) {
    server.registerTool(
      "list_workflows",
      {
        title: "List n8n workflows (read-only)",
        description:
          "Lists workflows in the n8n instance (id, name, active status). Read-only — cannot create, edit, or delete anything.",
        inputSchema: {},
      },
      async () => {
        try {
          const text = await n8nApiGet("/workflows");
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }
    );

    server.registerTool(
      "get_workflow",
      {
        title: "Get n8n workflow detail (read-only)",
        description:
          "Fetches the full definition (nodes, connections, settings) of one workflow by its id. Read-only.",
        inputSchema: {
          workflow_id: z.string().describe("The n8n workflow id, e.g. 'a0maIdHvdCHvunBY'"),
        },
      },
      async ({ workflow_id }) => {
        try {
          const text = await n8nApiGet(`/workflows/${encodeURIComponent(workflow_id)}`);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }
    );

    server.registerTool(
      "list_executions",
      {
        title: "List n8n executions (read-only)",
        description:
          "Lists recent workflow executions, optionally filtered by workflowId. Read-only.",
        inputSchema: {
          workflow_id: z.string().optional().describe("Optional: only executions for this workflow id"),
          limit: z.number().optional().describe("Optional: max number of executions to return (default n8n limit)"),
        },
      },
      async ({ workflow_id, limit }) => {
        try {
          const params = new URLSearchParams();
          if (workflow_id) params.set("workflowId", workflow_id);
          if (limit) params.set("limit", String(limit));
          const qs = params.toString() ? `?${params.toString()}` : "";
          const text = await n8nApiGet(`/executions${qs}`);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }
    );

    server.registerTool(
      "get_execution",
      {
        title: "Get n8n execution detail (read-only)",
        description:
          "Fetches full detail of one execution by id, including per-node input/output data — useful for diagnosing why a run failed or behaved unexpectedly. Read-only. Large execution payloads are automatically truncated to a preview to avoid overflowing context.",
        inputSchema: {
          execution_id: z.string().describe("The n8n execution id"),
        },
      },
      async ({ execution_id }) => {
        try {
          const text = await n8nApiGet(
            `/executions/${encodeURIComponent(execution_id)}?includeData=true`
          );

          let payload = text;
          try {
            const json = JSON.parse(text);
            const dataStr = JSON.stringify(json.data ?? {});
            if (dataStr.length > MAX_EXECUTION_DATA_CHARS) {
              json.data = {
                truncated: true,
                note: `Execution data was ${dataStr.length} chars and has been truncated to a ${MAX_EXECUTION_DATA_CHARS}-char preview to avoid overflowing context. Ask about a specific node by name for more targeted detail if this endpoint is extended later.`,
                preview: dataStr.slice(0, MAX_EXECUTION_DATA_CHARS),
              };
            }
            payload = JSON.stringify(json);
          } catch (parseErr) {
            // Response wasn't valid JSON — fall back to raw text.
          }

          return { content: [{ type: "text", text: payload }] };
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }
    );

    server.registerTool(
      "patch_node_parameter",
      {
        title: "Patch a single n8n node parameter (write, dry-run by default)",
        description:
          "Changes ONE parameter on ONE node inside a workflow. Defaults to dry_run=true, which returns the current value, the proposed new value, and a diff WITHOUT writing anything. Only pass dry_run:false after reviewing the dry-run output — this then writes the change and re-fetches the workflow to verify the new value actually landed live.",
        inputSchema: {
          workflow_id: z.string().describe("The n8n workflow id, e.g. '35inTs8bss3QeHVo'"),
          node_id: z.string().describe("The node's id (not its display name), e.g. 'a956e6a1'"),
          parameter_path: z
            .string()
            .describe("Dot path inside node.parameters to change, e.g. 'url' or 'options.timeout'"),
          new_value: z
            .string()
            .describe("The new value to set (as a string; numbers/bools should be passed as their string form and will be used as-is)"),
          dry_run: z
            .boolean()
            .optional()
            .default(true)
            .describe("If true (default), only preview the change. If false, actually write it and verify."),
        },
      },
      async ({ workflow_id, node_id, parameter_path, new_value, dry_run = true }) => {
        try {
          // 1. Fresh read — never operate on stale/cached workflow data.
          const currentText = await n8nApiGet(`/workflows/${encodeURIComponent(workflow_id)}`);
          const workflow = JSON.parse(currentText);

          const node = (workflow.nodes || []).find((n) => n.id === node_id);
          if (!node) {
            return {
              content: [
                {
                  type: "text",
                  text: `Node id '${node_id}' not found in workflow '${workflow_id}'. No changes made.`,
                },
              ],
              isError: true,
            };
          }

          const oldValue = getByPath(node.parameters || {}, parameter_path);

          if (dry_run) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      dry_run: true,
                      workflow_id,
                      node_id,
                      node_name: node.name,
                      parameter_path,
                      current_value: oldValue,
                      proposed_value: new_value,
                      note: "Nothing was written. Call again with dry_run:false to apply this exact change.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // 2. Apply the single-field change to a full in-memory copy.
          if (!node.parameters) node.parameters = {};
          setByPath(node.parameters, parameter_path, new_value);

          // 3. Write the whole workflow back.
          await n8nApiPut(`/workflows/${encodeURIComponent(workflow_id)}`, workflow);

          // 4. LIVE VERIFY — re-fetch fresh, don't trust the PUT response alone.
          const verifyText = await n8nApiGet(`/workflows/${encodeURIComponent(workflow_id)}`);
          const verifyWorkflow = JSON.parse(verifyText);
          const verifyNode = (verifyWorkflow.nodes || []).find((n) => n.id === node_id);
          const verifiedValue = verifyNode ? getByPath(verifyNode.parameters || {}, parameter_path) : undefined;

          const verified = String(verifiedValue) === String(new_value);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    dry_run: false,
                    workflow_id,
                    node_id,
                    node_name: node.name,
                    parameter_path,
                    old_value: oldValue,
                    attempted_value: new_value,
                    live_verified_value: verifiedValue,
                    LIVE_VERIFIED: verified,
                    note: verified
                      ? "Write confirmed live in n8n."
                      : "WARNING: post-write read does not match the attempted value. Do not assume the change succeeded — investigate before proceeding.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: !verified,
          };
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }
    );
  }

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
