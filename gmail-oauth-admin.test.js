import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GMAIL_REDIRECT_URI,
  GMAIL_SCOPES,
  buildGoogleAuthUrl,
  credentialsFromTokenResponse,
  parseGoogleCallback,
  writeCredentialsSafely,
} from "./gmail-oauth-admin.js";

test("Google authorization URL uses the existing desktop callback and requests offline consent", () => {
  const url = new URL(buildGoogleAuthUrl({ clientId: "client-id", state: "state-value" }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), GMAIL_REDIRECT_URI);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent select_account");
  assert.deepEqual(url.searchParams.get("scope").split(" "), GMAIL_SCOPES);
});

test("callback accepts only the exact localhost return URL and matching state", () => {
  const good = "http://localhost:3000/oauth2callback?code=abc123456&state=same";
  assert.equal(parseGoogleCallback(good, "same"), "abc123456");
  assert.throws(() => parseGoogleCallback("https://evil.example/oauth2callback?code=abc123456&state=same", "same"), /不是本次/);
  assert.throws(() => parseGoogleCallback("http://localhost:3000/oauth2callback?code=abc123456&state=wrong", "same"), /校验已失效/);
  assert.throws(() => parseGoogleCallback("http://localhost:3000/oauth2callback?error=access_denied&state=same", "same"), /没有授权/);
});

test("token response is converted to the credential shape expected by Gmail MCP", () => {
  const now = 1_700_000_000_000;
  const result = credentialsFromTokenResponse({
    access_token: "access",
    refresh_token: "refresh",
    scope: "scope-a scope-b",
    token_type: "Bearer",
    expires_in: 3600,
  }, now);
  assert.deepEqual(result, {
    access_token: "access",
    refresh_token: "refresh",
    scope: "scope-a scope-b",
    token_type: "Bearer",
    expiry_date: now + 3_600_000,
  });
  assert.throws(() => credentialsFromTokenResponse({ access_token: "access" }, now), /长期刷新令牌/);
});

test("new credentials are installed only with a private backup and completion marker", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-oauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsFile = path.join(dir, "credentials.json");
  const markerFile = path.join(dir, ".new-account-authorized");
  const oldCredentials = { access_token: "old-access", refresh_token: "old-refresh" };
  const newCredentials = { access_token: "new-access", refresh_token: "new-refresh" };
  fs.writeFileSync(credentialsFile, JSON.stringify(oldCredentials));

  writeCredentialsSafely(credentialsFile, markerFile, newCredentials, new Date("2026-08-21T12:00:00.000Z"));

  assert.deepEqual(JSON.parse(fs.readFileSync(credentialsFile, "utf8")), newCredentials);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "credentials.previous.json"), "utf8")), oldCredentials);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), { completedAt: "2026-08-21T12:00:00.000Z" });
  assert.equal(fs.statSync(credentialsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "credentials.previous.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(markerFile).mode & 0o777, 0o600);
});
