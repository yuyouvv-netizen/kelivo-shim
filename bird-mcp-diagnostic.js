const MCP_PROTOCOL_VERSION = "2025-03-26";
const EXPECTED_TOOLS = ["toy_control", "toy_status"];

function rpcHeaders(sessionId) {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
  };
}

async function rpcPayload(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find(Boolean);
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

async function postRpc(fetchImpl, url, message, { sessionId, signal } = {}) {
  return fetchImpl(url, {
    method: "POST",
    headers: rpcHeaders(sessionId),
    body: JSON.stringify(message),
    signal,
  });
}

export async function diagnoseBirdMcp({
  url,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!url) return { configured: false, ready: false, status: "disabled" };

  let pathLooksLikeMcp = false;
  try {
    const parsed = new URL(url);
    pathLooksLikeMcp = parsed.protocol === "https:" && /^\/mcp\/[^/]+/.test(parsed.pathname);
  } catch {
    return { configured: true, ready: false, status: "invalid-url", pathLooksLikeMcp };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const initialized = await postRpc(fetchImpl, url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "kelivo-shim-diagnostic", version: "1" },
      },
    }, { signal: controller.signal });
    if (!initialized.ok) {
      return {
        configured: true, ready: false, status: "http-error",
        pathLooksLikeMcp, httpStatus: initialized.status,
      };
    }

    let init;
    try { init = await rpcPayload(initialized); }
    catch {
      return { configured: true, ready: false, status: "invalid-response", pathLooksLikeMcp };
    }
    if (init?.error) {
      return {
        configured: true, ready: false, status: "rpc-error", pathLooksLikeMcp,
        rpcCode: Number.isFinite(init.error.code) ? init.error.code : null,
      };
    }
    if (!init?.result?.serverInfo) {
      return { configured: true, ready: false, status: "invalid-initialize", pathLooksLikeMcp };
    }

    const sessionId = initialized.headers.get("mcp-session-id") || "";
    await postRpc(fetchImpl, url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, { sessionId, signal: controller.signal });

    const listed = await postRpc(fetchImpl, url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, { sessionId, signal: controller.signal });
    if (!listed.ok) {
      return {
        configured: true, ready: false, status: "tools-http-error",
        pathLooksLikeMcp, httpStatus: listed.status,
      };
    }

    let list;
    try { list = await rpcPayload(listed); }
    catch {
      return { configured: true, ready: false, status: "invalid-tools-response", pathLooksLikeMcp };
    }
    const toolNames = Array.isArray(list?.result?.tools)
      ? list.result.tools.map((tool) => String(tool?.name || "")).filter(Boolean)
      : [];
    const ready = EXPECTED_TOOLS.every((name) => toolNames.includes(name));
    return {
      configured: true,
      ready,
      status: ready ? "ok" : "unexpected-tools",
      pathLooksLikeMcp,
      protocolVersion: String(init.result.protocolVersion || ""),
      serverName: String(init.result.serverInfo.name || ""),
      toolNames,
    };
  } catch (error) {
    return {
      configured: true,
      ready: false,
      status: error?.name === "AbortError" ? "timeout" : "network-error",
      pathLooksLikeMcp,
    };
  } finally {
    clearTimeout(timer);
  }
}
