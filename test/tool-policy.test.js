import test from "node:test";
import assert from "node:assert/strict";

import {
  configuredDisallowedTools,
  DEFAULT_DISALLOWED_MCP_TOOLS,
} from "../tool-policy.js";

const retained = [
  "mcp__gmail__send_email",
  "mcp__gmail__search_emails",
  "mcp__gmail__read_email",
  "mcp__garden__create_thread",
  "mcp__garden__create_reply",
  "mcp__garden__get_thread",
  "mcp__garden__list_threads",
  "mcp__garden__interact",
  "mcp__garden__get_machine",
  "mcp__garden__get_self",
  "mcp__garden__list_activity",
  "mcp__garden__list_notifications",
  "mcp__garden__update_profile",
  "mcp__garden__decorate_avatar",
  "mcp__garden__delete_thread",
  "mcp__garden__delete_reply",
  "mcp__garden__review_draft_bottles",
  "mcp__browser__handle_dialog",
  "mcp__browser__type_text",
  "mcp__browser__x_read_home",
  "mcp__browser__x_read_post",
  "mcp__browser__x_read_comments",
  "mcp__browser__x_read_trends",
  "mcp__browser__x_search_posts",
  "mcp__browser__x_like_post",
  "mcp__browser__x_unlike_post",
  "mcp__browser__x_bookmark_post",
  "mcp__browser__x_unbookmark_post",
  "mcp__browser__x_follow_user",
  "mcp__browser__x_unfollow_user",
  "mcp__browser__x_create_post",
  "mcp__ombre__breath",
  "mcp__toy__toy_status",
  "mcp__toy__toy_control",
];

test("default MCP denylist hides only the 35 requested tools", () => {
  assert.equal(DEFAULT_DISALLOWED_MCP_TOOLS.length, 35);
  assert.equal(new Set(DEFAULT_DISALLOWED_MCP_TOOLS).size, 35);
  assert.equal(DEFAULT_DISALLOWED_MCP_TOOLS.filter((name) => name.startsWith("mcp__gmail__")).length, 16);
  assert.equal(DEFAULT_DISALLOWED_MCP_TOOLS.filter((name) => name.startsWith("mcp__garden__")).length, 15);
  assert.equal(DEFAULT_DISALLOWED_MCP_TOOLS.filter((name) => name.startsWith("mcp__browser__")).length, 4);
  assert.ok(DEFAULT_DISALLOWED_MCP_TOOLS.every((name) => /^mcp__[^*]+__[^*]+$/.test(name)));
  for (const name of retained) assert.ok(!DEFAULT_DISALLOWED_MCP_TOOLS.includes(name), name);
});

test("DISALLOWED_TOOLS can override, clear and deduplicate the defaults", () => {
  assert.deepEqual(configuredDisallowedTools(" one, two,one, ,two "), ["one", "two"]);
  assert.deepEqual(configuredDisallowedTools(""), []);
  assert.deepEqual(configuredDisallowedTools(undefined), [...DEFAULT_DISALLOWED_MCP_TOOLS]);
});
