import fs from "fs";

function readableFile(file) {
  return Boolean(file && fs.existsSync(file) && fs.lstatSync(file).isFile());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function oauthClientOf(value) {
  const client = value?.installed || value?.web;
  if (!client?.client_id || !client?.client_secret) throw new Error("invalid-oauth-client");
  return client;
}

export async function diagnoseStoredGmailAuth({
  oauthFile = process.env.GMAIL_OAUTH_PATH,
  credentialsFile = process.env.GMAIL_CREDENTIALS_PATH,
  mcpConfigFile = process.env.MCP_CONFIG || ".mcp.json",
  fetchImpl = globalThis.fetch,
} = {}) {
  const oauthReadable = readableFile(oauthFile);
  const credentialsReadable = readableFile(credentialsFile);
  const result = {
    configured: Boolean(oauthFile && credentialsFile),
    source: String(oauthFile || "").startsWith("/persona/") && String(credentialsFile || "").startsWith("/persona/")
      ? "private-volume"
      : "other",
    files: { oauthReadable, credentialsReadable },
    mcpConfig: { present: readableFile(mcpConfigFile), oauthPathMatches: false, credentialsPathMatches: false },
    refresh: "not-run",
    gmailProfile: "not-run",
  };

  if (result.mcpConfig.present) {
    try {
      const gmailEnv = readJson(mcpConfigFile)?.mcpServers?.gmail?.env || {};
      result.mcpConfig.oauthPathMatches = gmailEnv.GMAIL_OAUTH_PATH === oauthFile;
      result.mcpConfig.credentialsPathMatches = gmailEnv.GMAIL_CREDENTIALS_PATH === credentialsFile;
    } catch {
      result.mcpConfig.error = "invalid-json";
    }
  }

  if (!oauthReadable || !credentialsReadable) {
    result.refresh = "missing-file";
    return result;
  }

  let client;
  let credentials;
  try {
    client = oauthClientOf(readJson(oauthFile));
    credentials = readJson(credentialsFile);
  } catch (error) {
    result.refresh = error.message === "invalid-oauth-client" ? error.message : "invalid-json";
    return result;
  }
  if (!credentials?.refresh_token) {
    result.refresh = "missing-refresh-token";
    return result;
  }

  let tokenResponse;
  let token;
  try {
    tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: String(client.client_id),
        client_secret: String(client.client_secret),
        refresh_token: String(credentials.refresh_token),
        grant_type: "refresh_token",
      }),
    });
    token = await tokenResponse.json().catch(() => null);
  } catch {
    result.refresh = "network-error";
    return result;
  }

  if (!tokenResponse.ok || !token?.access_token) {
    result.refresh = typeof token?.error === "string" ? token.error : `http-${tokenResponse.status}`;
    return result;
  }
  result.refresh = "ok";

  try {
    const profileResponse = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = await profileResponse.json().catch(() => null);
    result.gmailProfile = profileResponse.ok && profile?.emailAddress ? "ok" : `http-${profileResponse.status}`;
  } catch {
    result.gmailProfile = "network-error";
  }
  return result;
}
