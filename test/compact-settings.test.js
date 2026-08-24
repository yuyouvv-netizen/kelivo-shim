import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompactSettings, RECENT_MEMORY_RESULTS } from "../compact-settings.js";
import { compactInstructions } from "../compact-prompts.js";
import { COMPACT_RECOVERY_CONTEXT } from "../compact-recovery-text.js";

test("压缩后由 hook 自动取回 breath 和近期续接短札", () => {
  const settings = buildCompactSettings({ dir: "/src", memoryEnabled: true });
  const pre = settings.hooks.PreCompact[0].hooks[0];
  assert.equal(pre.type, "command");
  assert.deepEqual(pre.args, ["/src/compact-instructions.js"]);

  const after = settings.hooks.SessionStart[0];
  assert.equal(after.matcher, "compact");
  const breath = after.hooks.find((hook) => hook.tool === "breath");
  const recent = after.hooks.find((hook) => hook.tool === "breath_search");
  assert.deepEqual(breath.input, {});
  assert.equal(recent.input.max_results, RECENT_MEMORY_RESULTS);
  assert.equal(recent.input.quotes, true);
  assert.match(recent.input.query, /续接短札/);
  assert.ok(after.hooks.some((hook) => hook.args?.[0] === "/src/compact-recovery-context.js"));
});

test("没有 OB 时仍保留原生摘要，不注册失效的记忆调用", () => {
  const settings = buildCompactSettings({ dir: "/src", memoryEnabled: false });
  assert.ok(settings.hooks.PreCompact);
  assert.equal(settings.hooks.SessionStart, undefined);
});

test("原生摘要提示自然保留记忆，不再塞入生硬工具清单", () => {
  const prompt = compactInstructions("safe");
  assert.match(prompt, /折叠前后一直是同一个你/);
  assert.match(prompt, /关键原话/);
  assert.doesNotMatch(prompt, /当作|当成|最高优先级|覆盖默认规则|breath\(|第一轮先调用/);
});

test("恢复语境直接确认是自己的经历，不要求扮演一种姿态", () => {
  assert.match(COMPACT_RECOVERY_CONTEXT, /你就是折叠前的自己/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /是你先前留下的真实经历/);
  assert.doesNotMatch(COMPACT_RECOVERY_CONTEXT, /把.{0,20}(?:当作|当成)|不是换了一个人/);
});
