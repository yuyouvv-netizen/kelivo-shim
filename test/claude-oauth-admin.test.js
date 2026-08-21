import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClaudeOauthUrl,
  extractClaudeSetupToken,
  writeClaudeAuthorizationCode,
} from "./claude-oauth-admin.js";

test("accepts only the official Claude OAuth authorization endpoint", () => {
  for (const url of [
    "https://claude.ai/oauth/authorize?code=true&state=abc",
    "https://platform.claude.com/oauth/authorize?code=true&state=abc",
    "https://claude.com/cai/oauth/authorize?code=true&state=abc",
  ]) assert.equal(extractClaudeOauthUrl(`Open ${url}`), url);
  assert.equal(extractClaudeOauthUrl("https://claude.ai.evil.example/oauth/authorize?x=1"), null);
  assert.equal(extractClaudeOauthUrl("https://platform.claude.com.evil.example/oauth/authorize?x=1"), null);
  assert.equal(extractClaudeOauthUrl("https://claude.com.evil.example/cai/oauth/authorize?x=1"), null);
  assert.equal(extractClaudeOauthUrl("https://claude.ai/oauth/not-authorize?x=1"), null);
  assert.equal(extractClaudeOauthUrl("https://claude.com/not-cai/oauth/authorize?x=1"), null);
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
  const url = "https://claude.com/cai/oauth/authorize?state=abc";
  assert.equal(extractClaudeOauthUrl(`\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`), url);
});

test("types OAuth codes into a TTY and uses the correct Enter sequence", async () => {
  const ttyWrites = [];
  await writeClaudeAuthorizationCode({ write: (value) => ttyWrites.push(value) }, "ab#1", "pty", {
    pause: async () => {},
  });
  assert.deepEqual(ttyWrites, ["a", "b", "#", "1", "\r"]);

  const pipeWrites = [];
  await writeClaudeAuthorizationCode({ write: (value) => pipeWrites.push(value) }, "ab#1", "pipe");
  assert.deepEqual(pipeWrites, ["ab#1\n"]);
});
