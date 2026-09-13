// n8n Supervisor MCP Adapter
// Exposes:
//  - send_supervisor_command: forwards a command to your n8n Supervisor webhook.
//    If the initial POST times out or returns HTTP 524 (Cloudflare/n8n.cloud
//    gateway timeout — happens when the Supervisor loop takes longer than
//    ~100s to finish), this automatically falls back to polling the n8n API
//    for the matching execution until it finishes, then extracts and returns
//    the real final result instead of just surfacing the 524 error.
//  - READ-ONLY n8n API tools: list_workflows, get_workflow, list_executions,
//    get_execution — these only ever call GET on the n8n REST API.
//  - patch_node_parameter: a SCOPED write tool — changes exactly one
//    parameter on one existing node, dry-run by default, with a live
//    post-write verification read.
//  - creatomate_renders: READ-ONLY Creatomate render log. Without a
//    render_id it lists recent renders (id, status, error_message); with a
//    render_id it returns that render in full, including the composition
//    source that was submitted. Only ever calls GET.
//
// Required environment variables (set these on your host, NEVER in code):
//   SUPERVISOR_WEBHOOK_URL   e.g. https://your-n8n-host/webhook/openai-supervisor-loop
//   SUPERVISOR_AUTH_HEADER_NAME   e.g. "Authorization" or your custom header name
//   SUPERVISOR_AUTH_HEADER_VALUE  the secret value for that header (the "ChatGPT Bridge Auth" key)
//   N8N_API_BASE_URL   e.g. https://your-n8n-host/api/v1
//   N8N_API_KEY        your n8n API key (read-only scope)
//   PORT (optional, defaults to 3000)
//
// Optional (enables the 524 polling fallback for send_supervisor_command):
//   SUPERVISOR_WORKFLOW_ID   the n8n workflow id of the Supervisor Loop workflow
//                            (falls back to 'a0maIdHvdCHvunBY' if unset — set this
//                            explicitly if your Supervisor workflow id differs)
//
// Optional (used by patch_node_parameter's write step; recommended for
// least-privilege — keeps N8N_API_KEY permanently read-only):
//   N8N_API_WRITE_KEY   a separate n8n API key scoped to only
//                       workflow:create/list/read/update (no delete, no
//                       activate/deactivate, no executions/credentials).
//                       If unset, N8N_API_KEY is used for writes too.
//
// Optional (enables the creatomate_renders tool):
//   CREATOMATE_API_KEY  your Creatomate API key. Read-only usage: the tool
//                       only ever issues GET /v1/renders requests.

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
  N8N_API_WRITE_KEY,
  CREATOMATE_API_KEY,
  SUPERVISOR_WORKFLOW_ID = "a0maIdHvdCHvunBY",
  PORT = 3000,
} = process.env;

if (!SUPERVISOR_WEBHOOK_URL || !SUPERVISOR_AUTH_HEADER_NAME || !SUPERVISOR_AUTH_HEADER_VALUE) {
  console.error(
    "Missing required env vars: SUPERVISOR_WEBHOOK_URL, SUPERVISOR_AUTH_HEADER_NAME, SUPERVISOR_AUTH_HEADER_VALUE"
  );
  process.exit(1);
}

// n8n API tools (and the 524 polling fallback) are optional — only enabled if these are set.
const N8N_API_ENABLED = Boolean(N8N_API_BASE_URL && N8N_API_KEY);

// Creatomate render-log tool is optional — only enabled if the key is set.
const CREATOMATE_ENABLED = Boolean(CREATOMATE_API_KEY);
const CREATOMATE_API_BASE_URL = "https://api.creatomate.com/v1";

// Max characters of a single Creatomate render payload to return before truncating.
const MAX_CREATOMATE_RENDER_CHARS = 20000;

// Max characters of an execution's "data" payload to return before truncating.
const MAX_EXECUTION_DATA_CHARS = 15000;

// How long to wait for the initial synchronous POST before treating it as
// "gateway will time out anyway" and switching to polling. Kept a little
// under Cloudflare's ~100s limit so we control the cutover ourselves.
const INITIAL_REQUEST_TIMEOUT_MS = 90000;

// Polling fallback tuning.
const POLL_INTERVAL_MS = 8000;
const POLL_MAX_ATTEMPTS = 30; // ~4 minutes total

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
  // Prefer a dedicated write-scoped key (workflow:update etc.) so the
  // read-only N8N_API_KEY's permissions never need to grow. Falls back to
  // N8N_API_KEY if no separate write key is configured.
  const writeKey = N8N_API_WRITE_KEY || N8N_API_KEY;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": writeKey,
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

// Read-only Creatomate GET. Never used for POST/PUT/DELETE — this adapter
// cannot start or cancel renders, only inspect them.
async function creatomateApiGet(path) {
  const url = `${CREATOMATE_API_BASE_URL}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CREATOMATE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Creatomate API GET ${path} returned HTTP ${resp.status}: ${text}`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Given a finished Supervisor Loop execution's full data, pull out the
// human-readable final answer the same way the workflow's own
// "Return Final Result" / "Build Loop Limit Response" nodes would.
function extractFinalOutputFromExecution(execJson) {
  const runData = execJson?.resultData?.runData;
  if (!runData) return null;

  // Loop-limit-reached path.
  const loopLimitRuns = runData["Build Loop Limit Response"];
  if (Array.isArray(loopLimitRuns) && loopLimitRuns.length > 0) {
    const last = loopLimitRuns[loopLimitRuns.length - 1];
    const val = last?.data?.main?.[0]?.[0]?.json?.status;
    if (val) return String(val);
  }

  // Normal path: last "Supervisor Review" run should carry the final
  // "DONE: ..." text (the workflow strips the "DONE:" prefix itself).
  const reviewRuns = runData["Supervisor Review"];
  if (Array.isArray(reviewRuns) && reviewRuns.length > 0) {
    const last = reviewRuns[reviewRuns.length - 1];
    const output = last?.data?.main?.[0]?.[0]?.json?.output;
    if (typeof output === "string") {
      if (/^DONE:\s*/i.test(output)) {
        return output.replace(/^DONE:\s*/i, "");
      }
      return `${output}\n\n(Note: execution finished but the last recorded step was still CONTINUE — this may be an incomplete result.)`;
    }
  }

  return null;
}

async function pollForSupervisorResult(commandSentAt) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    let listText;
    try {
      listText = await n8nApiGet(`/executions?workflowId=${encodeURIComponent(SUPERVISOR_WORKFLOW_ID)}&limit=1`);
    } catch (err) {
      continue; // transient — just try again next tick
    }

    let list;
    try {
      list = JSON.parse(listText);
    } catch {
      continue;
    }

    const latest = (list?.data || [])[0];
    if (!latest) continue;

    // Make sure this execution actually started at/after our command,
    // not a stale prior run.
    const startedAt = latest.startedAt ? new Date(latest.startedAt).getTime() : 0;
    if (startedAt < commandSentAt - 5000) continue; // too old, not our run yet

    if (!latest.finished) continue; // still running, keep polling

    let fullText;
    try {
      fullText = await n8nApiGet(`/executions/${encodeURIComponent(latest.id)}?includeData=true`);
    } catch (err) {
      return { error: `Execution ${latest.id} finished but re-fetching full data failed: ${err.message}` };
    }

    let fullJson;
    try {
      fullJson = JSON.parse(fullText);
    } catch {
      return { error: `Execution ${latest.id} finished but its data could not be parsed.` };
    }

    const finalOutput = extractFinalOutputFromExecution(fullJson.data || fullJson);

    return {
      executionId: latest.id,
      status: latest.status,
      finalOutput: finalOutput || "(Execution finished but no recognizable final output field was found — inspect with get_execution.)",
    };
  }

  return { error: `Gave up polling after ${POLL_MAX_ATTEMPTS} attempts (~${Math.round((POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000)}s). The Supervisor run may still be in progress — check with list_executions/get_execution.` };
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
        "Sends a single text command to the n8n Supervisor workflow and returns its response. Use this whenever the user asks you to run, check, or relay a command to their n8n Supervisor (e.g. 'STATUS', or a diagnostic/fix command). If the run takes longer than ~90s and the gateway times out (HTTP 524), this automatically falls back to polling for the result instead of just failing.",
      inputSchema: {
        command: z.string().describe("The command text to send to the Supervisor, e.g. 'STATUS'"),
      },
    },
    async ({ command }) => {
      const sentAt = Date.now();

      let resp;
      let timedOutLocally = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          timedOutLocally = true;
          controller.abort();
        }, INITIAL_REQUEST_TIMEOUT_MS);

        try {
          resp = await fetch(SUPERVISOR_WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [SUPERVISOR_AUTH_HEADER_NAME]: SUPERVISOR_AUTH_HEADER_VALUE,
            },
            body: JSON.stringify({ command }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (!timedOutLocally) {
          return {
            content: [{ type: "text", text: `Failed to reach Supervisor: ${err.message}` }],
            isError: true,
          };
        }
        resp = null;
      }

      const gatewayTimedOut = resp && resp.status === 524;

      if (resp && resp.ok) {
        const text = await resp.text();
        return { content: [{ type: "text", text }] };
      }

      if (resp && !resp.ok && !gatewayTimedOut) {
        const text = await resp.text();
        return {
          content: [{ type: "text", text: `Supervisor returned HTTP ${resp.status}: ${text}` }],
          isError: true,
        };
      }

      if (!N8N_API_ENABLED) {
        return {
          content: [
            {
              type: "text",
              text: "Supervisor request timed out (gateway 524) and the polling fallback is disabled (N8N_API_BASE_URL/N8N_API_KEY not set). The n8n execution may still complete in the background — check manually in n8n.",
            },
          ],
          isError: true,
        };
      }

      const result = await pollForSupervisorResult(sentAt);

      if (result.error) {
        return { content: [{ type: "text", text: `Gateway timed out, then polling failed: ${result.error}` }], isError: true };
      }

      return {
        content: [
          {
            type: "text",
            text: `[Note: initial request hit a gateway timeout; result recovered via polling. Execution ${result.executionId}, status: ${result.status}]\n\n${result.finalOutput}`,
          },
        ],
      };
    }
  );

  if (CREATOMATE_ENABLED) {
    server.registerTool(
      "creatomate_renders",
      {
        title: "Creatomate render log (read-only)",
        description:
          "Read-only view of the Creatomate render log. Without render_id: lists the most recent renders with id, status, error_message and output url — use this to see why a render failed. With render_id: returns that single render in full, including the composition source that was submitted. Only ever issues GET requests; cannot start, modify or cancel renders.",
        inputSchema: {
          render_id: z
            .string()
            .optional()
            .describe("Optional: a specific Creatomate render id, e.g. '150b3c58-c895-438d-9bc3-416737b5151c'. Omit to list recent renders."),
          limit: z
            .number()
            .optional()
            .describe("Optional: how many recent renders to list (1-20, default 5). Ignored when render_id is given."),
        },
      },
      async ({ render_id, limit }) => {
        try {
          if (render_id) {
            const text = await creatomateApiGet(`/renders/${encodeURIComponent(render_id)}`);
            const payload =
              text.length > MAX_CREATOMATE_RENDER_CHARS
                ? `${text.slice(0, MAX_CREATOMATE_RENDER_CHARS)}\n\n[truncated: render payload was ${text.length} chars]`
                : text;
            return { content: [{ type: "text", text: payload }] };
          }

          const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
          const text = await creatomateApiGet(`/renders?limit=${n}`);

          let payload = text;
          try {
            const parsed = JSON.parse(text);
            const list = Array.isArray(parsed) ? parsed : parsed?.data || [];
            const slim = list.slice(0, n).map((r) => ({
              id: r.id,
              status: r.status,
              error_message: r.error_message || null,
              created_at: r.created_at || null,
              url: r.url || null,
            }));
            payload = JSON.stringify({ count: slim.length, renders: slim }, null, 2);
          } catch (parseErr) {
            // Response wasn't valid JSON — fall back to raw text.
          }

          return { content: [{ type: "text", text: payload }] };
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }
    );
  }

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
          node_id: z.string().describe("The node's id (not its display name), e.g. 'a956e6a1-ff86-4362-befb-ab04c4efc8d0'"),
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

          if (!node.parameters) node.parameters = {};
          setByPath(node.parameters, parameter_path, new_value);

          // n8n's PUT /workflows/{id} endpoint has a strict schema and
          // rejects extra read-only fields (createdAt, versionId,
          // activeVersion, shared, etc.) that GET returns. Send only the
          // minimal accepted set, mutated in place above.
          const minimalPayload = {
            name: workflow.name,
            nodes: workflow.nodes,
            connections: workflow.connections,
            settings: workflow.settings || {},
          };
          await n8nApiPut(`/workflows/${encodeURIComponent(workflow_id)}`, minimalPayload);

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

app.get("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`n8n Supervisor MCP adapter listening on port ${PORT}`);
});
