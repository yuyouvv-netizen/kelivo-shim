import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveToolResultOk, growSavedMemory } from "../archive.js";

test("grow 预拆分结果至少落盘一条才算归档成功", () => {
  assert.equal(growSavedMemory('{"result":"5条(预拆分·逐字)|新5合0 batch:g_43808b81a13f\\n📝一\\n📝二"}'), true);
  assert.equal(growSavedMemory("4条|新1合3 batch:g_123abc\n📎旧桶"), true);
  assert.equal(growSavedMemory("3条|新0合0 batch:g_deadbeef\n⚠️一\n⚠️二\n⚠️三"), false);
});

test("grow 短内容成功路径可识别", () => {
  assert.equal(growSavedMemory("短内容已按 hold 路径保存为单条记忆，没有拆分。\n新建 → 一件小事"), true);
  assert.equal(growSavedMemory("内容为空，无法整理。"), false);
});

test("工具报错不能因正文像成功结果而误判", () => {
  assert.equal(archiveToolResultOk("grow", "2条|新2合0 batch:g_abc", true), false);
  assert.equal(archiveToolResultOk("grow", "❌ [OB-E004] MCP 工具执行异常", false), false);
});

test("保留 archive_session 旧接口兼容", () => {
  assert.equal(archiveToolResultOk("archive_session", "🗄️ 已归档", false), true);
  assert.equal(archiveToolResultOk("archive_session", "归档失败", false), false);
});
