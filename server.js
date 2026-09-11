// ============================================================================
// ADDITION for server.js — patch_node_parameter tool
// ============================================================================
// Paste this INSIDE buildServer(), after the existing get_execution tool
// registration, but still inside the `if (N8N_API_ENABLED) { ... }` block —
// this tool needs N8N_API_KEY too, and should only exist when that's set.
//
// You also need one new helper function (n8nApiPut) — paste that ALONGSIDE
// the existing n8nApiGet function, near the top of server.js.
//
// SAFETY MODEL (matches your stage 6 rules):
//   - dry_run defaults to true. It will show you exactly what would change
//     without writing anything, until you explicitly pass dry_run:false.
//   - It only ever touches ONE node's ONE parameter path — never replaces
//     connections, other nodes, or workflow settings.
//   - After a real write, it re-fetches the workflow fresh from n8n and
//     confirms the new value actually landed (LIVE_VERIFIED), rather than
//     trusting a 200 OK response alone.
//   - If the target node or parameter path isn't found, it fails loudly
//     instead of guessing.
// ============================================================================

// --- 1) Add this helper next to n8nApiGet ---------------------------------

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
// e.g. "url" or "options.timeout" — keeps this generic without needing a
// lodash dependency.
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

// --- 2) Add this tool registration, inside `if (N8N_API_ENABLED) { ... }` --

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
      new_value: z.string().describe("The new value to set (as a string; numbers/bools should be passed as their string form and will be used as-is)"),
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

      // 3. Write the whole workflow back (n8n's API requires the full
      //    object) — but the only field that actually changed is the one
      //    targeted parameter.
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
