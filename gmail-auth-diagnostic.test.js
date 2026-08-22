import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnoseStoredGmailAuth } from "./gmail-auth-diagnostic.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-diagnostic-"));
  const oauthFile = path.join(dir, "gcp-oauth.keys.json");
  const credentialsFile = path.join(dir, "credentials.json");
  const mcpConfigFile = path.join(dir, ".mcp.json");
  fs.writeFileSync(oauthFile, JSON.stringify({ installed: { client_id: "client", client_secret: "secret" } }));
  fs.writeFileSync(credentialsFile, JSON.stringify({ refresh_token: "refresh-token-value" }));
  fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { gmail: { env: {
    GMAIL_OAUTH_PATH: oauthFile,
    GMAIL_CREDENTIALS_PATH: credentialsFile,
  } } } }));
  return { dir, oauthFile, credentialsFile, mcpConfigFile };
}

test("diagnostic verifies the same files pinned into Gmail MCP", async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.dir, { recursive: true, force: true }));
  const calls = [];
  const result = await diagnoseStoredGmailAuth({ ...files, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "access-token-value" }), { status: 200 });
    return new Response(JSON.stringify({ emailAddress: "new@example.com" }), { status: 200 });
  } });
  assert.equal(result.refresh, "ok");
  assert.equal(result.gmailProfile, "ok");
  assert.equal(result.mcpConfig.oauthPathMatches, true);
  assert.equal(result.mcpConfig.credentialsPathMatches, true);
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].init.body), /refresh_token=refresh-token-value/);
  assert.doesNotMatch(JSON.stringify(result), /refresh-token-value|access-token-value|new@example/);
});

test("diagnostic reports Google's error without returning credentials", async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.dir, { recursive: true, force: true }));
  const result = await diagnoseStoredGmailAuth({ ...files, fetchImpl: async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked token" }), { status: 400 })
  });
  assert.equal(result.refresh, "invalid_grant");
  assert.equal(result.gmailProfile, "not-run");
  assert.doesNotMatch(JSON.stringify(result), /revoked token|secret/);
});

test("diagnostic identifies missing credential files", async () => {
  const result = await diagnoseStoredGmailAuth({
    oauthFile: "/does/not/exist/oauth.json",
    credentialsFile: "/does/not/exist/credentials.json",
    mcpConfigFile: "/does/not/exist/.mcp.json",
  });
  assert.equal(result.refresh, "missing-file");
  assert.equal(result.files.oauthReadable, false);
  assert.equal(result.files.credentialsReadable, false);
});
