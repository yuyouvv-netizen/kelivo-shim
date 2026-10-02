import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeModsSupported,
  clearClaudeModProbe,
  readClaudeModProbe,
  withClaudeModProbe,
} from "../claude-mods.js";

test("Mods support starts at Claude Code 2.1.287", () => {
  assert.equal(claudeModsSupported("2.1.286"), false);
  assert.equal(claudeModsSupported("2.1.287 (Claude Code)"), true);
  assert.equal(claudeModsSupported("2.1.288"), true);
  assert.equal(claudeModsSupported("2.2.0"), true);
  assert.equal(claudeModsSupported("unknown"), false);
});

test("disabled probe leaves plugin directories unchanged", () => {
  const env = { CLAUDE_CODE_PLUGIN_DIRS: "/one:/two" };
  assert.deepEqual(withClaudeModProbe(env, {
    enabled: false,
    pluginDir: "/probe",
    delimiter: ":",
  }), env);
});

test("enabled probe appends its directory exactly once", () => {
  const first = withClaudeModProbe({ CLAUDE_CODE_PLUGIN_DIRS: "/one" }, {
    enabled: true,
    pluginDir: "/probe",
    delimiter: ":",
  });
  assert.equal(first.CLAUDE_CODE_PLUGIN_DIRS, "/one:/probe");

  const second = withClaudeModProbe(first, {
    enabled: true,
    pluginDir: "/probe",
    delimiter: ":",
  });
  assert.equal(second.CLAUDE_CODE_PLUGIN_DIRS, "/one:/probe");
});

test("probe status reader fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-mod-probe-"));
  const file = path.join(dir, "probe.json");
  assert.equal(readClaudeModProbe(file), null);
  fs.writeFileSync(file, "not-json");
  assert.equal(readClaudeModProbe(file), null);
  fs.writeFileSync(file, JSON.stringify({ loaded: true, usage: { percent: 42 } }));
  assert.deepEqual(readClaudeModProbe(file), { loaded: true, usage: { percent: 42 } });
  assert.equal(clearClaudeModProbe(file), true);
  assert.equal(readClaudeModProbe(file), null);
});
