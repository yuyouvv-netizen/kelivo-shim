import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BREATH_REGULAR_RESULTS,
  buildCompactSettings,
  RECENT_LETTER_RESULTS,
  recentLetterDateFrom,
} from "../compact-settings.js";
import { compactInstructions } from "../compact-prompts.js";
import { COMPACT_RECOVERY_CONTEXT } from "../compact-recovery-text.js";

test("压缩后由 hook 自动取回钉选桶、八个普通桶和近期续接短札", () => {
  const now = Date.parse("2026-08-24T01:00:00+08:00");
  const settings = buildCompactSettings({ dir: "/src", memoryEnabled: true, now });
  const pre = settings.hooks.PreCompact[0].hooks[0];
  assert.equal(pre.type, "command");
  assert.deepEqual(pre.args, ["/src/compact-instructions.js"]);

  const after = settings.hooks.SessionStart[0];
  assert.equal(after.matcher, "compact");
  const breath = after.hooks.find((hook) => hook.tool === "breath");
  const recent = after.hooks.find((hook) => hook.tool === "letter_read");
  assert.deepEqual(breath.input, { max_results: BREATH_REGULAR_RESULTS });
  assert.equal(BREATH_REGULAR_RESULTS, 8);
  assert.equal(recent.input.limit, RECENT_LETTER_RESULTS);
  assert.equal(recent.input.author, "ai");
  assert.equal(recent.input.date_from, "2026-08-22");
  assert.match(recent.input.query, /续接短札/);
  assert.ok(after.hooks.some((hook) => hook.args?.[0] === "/src/compact-recovery-context.js"));
});

test("最近三天按新加坡自然日计算", () => {
  assert.equal(recentLetterDateFrom(Date.parse("2026-08-24T00:30:00+08:00")), "2026-08-22");
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
  assert.match(prompt, /长期记忆会在压缩后自然回到你这里/);
  assert.doesNotMatch(prompt, /当作|当成|最高优先级|覆盖默认规则|breath\(|第一轮先调用|钩子/);
});

test("恢复语境直接确认是自己的经历，不要求扮演一种姿态", () => {
  assert.match(COMPACT_RECOVERY_CONTEXT, /你就是折叠前的自己/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /记录的是你先前的真实经历/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /读回自己的经历/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /breath_search/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /只有检索后仍有关键缺口，再问又又/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /只有恢复报错、没有真实记忆返回/);
  assert.match(COMPACT_RECOVERY_CONTEXT, /自然接着和她说话/);
  assert.doesNotMatch(COMPACT_RECOVERY_CONTEXT, /以第一人称|把.{0,20}(?:当作|当成)|不是换了一个人|摘要不能替代|请她补一句|钩子/);
});
