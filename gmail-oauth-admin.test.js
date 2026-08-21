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
  ensureCanonicalGoogleOauthKeysFile,
  parseGoogleOauthClientJson,
  parseGoogleCallback,
  registerGmailOauthAdmin,
  resolveGoogleOauthKeysFile,
  writeCredentialsSafely,
  writeGoogleOauthClientFieldsSafely,
  writeGoogleOauthClientSafely,
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

test("OAuth client JSON is validated and stored privately", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-client-input-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "gcp-oauth.keys.json");
  const value = JSON.stringify({ installed: { client_id: "client", client_secret: "secret" } });

  assert.equal(parseGoogleOauthClientJson(value).clientId, "client");
  assert.throws(() => parseGoogleOauthClientJson("{}"), /格式不正确/);
  writeGoogleOauthClientSafely(target, value);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { installed: { client_id: "client", client_secret: "secret" } });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("OAuth client ID and secret are converted to the Gmail MCP file privately", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-client-fields-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "gcp-oauth.keys.json");

  writeGoogleOauthClientFieldsSafely(target, " client.apps.googleusercontent.com ", " GOCSPX-secret ");

  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
    installed: {
      client_id: "client.apps.googleusercontent.com",
      client_secret: "GOCSPX-secret",
    },
  });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.throws(() => writeGoogleOauthClientFieldsSafely(target, "", "secret"), /格式不正确/);
  assert.throws(() => writeGoogleOauthClientFieldsSafely(target, "client id", "secret"), /格式不正确/);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), { completedAt: "2026-08-21T12:00:00.000Z", migrationVersion: 2 });
  assert.equal(fs.statSync(credentialsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "credentials.previous.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(markerFile).mode & 0o777, 0o600);
});

test("a malformed credentials directory is preserved and replaced by a credentials file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-malformed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsFile = path.join(dir, "credentials.json");
  const markerFile = path.join(dir, ".new-account-authorized");
  const newCredentials = { access_token: "new-access", refresh_token: "new-refresh" };
  fs.mkdirSync(credentialsFile);
  fs.writeFileSync(path.join(credentialsFile, "preserved.txt"), "keep me");

  writeCredentialsSafely(credentialsFile, markerFile, newCredentials, new Date("2026-08-21T12:00:00.000Z"));

  assert.equal(fs.statSync(credentialsFile).isFile(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(credentialsFile, "utf8")), newCredentials);
  const preserved = fs.readdirSync(dir).find((name) => name.startsWith("credentials.malformed-"));
  assert.ok(preserved);
  assert.equal(fs.statSync(path.join(dir, preserved)).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(dir, preserved, "preserved.txt"), "utf8"), "keep me");
});

test("completion marker does not hide recovery page while credentials path is malformed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsFile = path.join(dir, "credentials.json");
  const markerFile = path.join(dir, ".new-account-authorized");
  fs.mkdirSync(credentialsFile);
  fs.writeFileSync(markerFile, "{}");
  const app = { use() {}, get() {}, post() {} };

  const result = registerGmailOauthAdmin(app, {
    shimKey: "secret",
    credentialsFile,
    markerFile,
    urlencoded: () => (_req, _res, next) => next(),
    json: () => (_req, _res, next) => next(),
    fetchImpl: async () => { throw new Error("unused"); },
    log: () => {},
  });

  assert.equal(result.enabled, true);
});

test("a stale marker does not hide recovery page even when credentials are a file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-stale-marker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsFile = path.join(dir, "credentials.json");
  const markerFile = path.join(dir, ".new-account-authorized");
  fs.writeFileSync(credentialsFile, "{}");
  fs.writeFileSync(markerFile, JSON.stringify({ completedAt: "2026-08-21T12:00:00.000Z" }));
  const app = { use() {}, get() {}, post() {} };

  const result = registerGmailOauthAdmin(app, {
    shimKey: "secret",
    credentialsFile,
    markerFile,
    urlencoded: () => (_req, _res, next) => next(),
    json: () => (_req, _res, next) => next(),
    fetchImpl: async () => { throw new Error("unused"); },
    log: () => {},
  });

  assert.equal(result.enabled, true);
});

test("OAuth client discovery accepts the restored runtime location", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-keys-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const restored = path.join(dir, ".gmail-mcp", "gcp-oauth.keys.json");
  fs.mkdirSync(path.dirname(restored), { recursive: true });
  fs.writeFileSync(restored, "{}");

  assert.equal(resolveGoogleOauthKeysFile("/missing/configured-file.json", dir), restored);
  assert.equal(resolveGoogleOauthKeysFile(path.join(dir, "missing.json"), path.join(dir, "other-home")), path.join(dir, "missing.json"));
});

test("OAuth client discovery recovers a key nested under malformed credentials directory", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-gmail-nested-keys-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, ".gmail-mcp", "credentials.json", "gcp-oauth.keys.json");
  const target = path.join(dir, "canonical", "gcp-oauth.keys.json");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify({ installed: { client_id: "client", client_secret: "secret" } }));

  const resolved = resolveGoogleOauthKeysFile(target, dir);
  assert.equal(resolved, source);
  assert.equal(ensureCanonicalGoogleOauthKeysFile(resolved, target), target);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { installed: { client_id: "client", client_secret: "secret" } });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});
