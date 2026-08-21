import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClaudeOauthUrl,
  extractClaudeSetupToken,
} from "../claude-oauth-admin.js";

test("accepts only the official Claude OAuth authorization endpoint", () => {
  assert.equal(
    extractClaudeOauthUrl("Open https://claude.ai/oauth/authorize?code=true&state=abc"),
    "https://claude.ai/oauth/authorize?code=true&state=abc",
  );
  assert.equal(extractClaudeOauthUrl("https://claude.ai.evil.example/oauth/authorize?x=1"), null);
  assert.equal(extractClaudeOauthUrl("https://claude.ai/oauth/not-authorize?x=1"), null);
  assert.equal(extractClaudeOauthUrl("http://claude.ai/oauth/authorize?x=1"), null);
});

test("extracts only the long-lived Claude OAuth token shape", () => {
  const token = "sk-ant-oat01-" + "aB_9-".repeat(11) + "aB_9";
  assert.equal(extractClaudeSetupToken(`created: ${token}`), token);
  assert.equal(extractClaudeSetupToken("sk-ant-api01-" + "x".repeat(80)), null);
  assert.equal(extractClaudeSetupToken("sk-ant-oat01-short"), null);
});

test("strips terminal color codes before parsing", () => {
  const token = "sk-ant-oat01-" + "z".repeat(60);
  assert.equal(extractClaudeSetupToken(`\u001b[32m${token}\u001b[0m`), token);
});
