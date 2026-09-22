import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_STOP_SEQUENCE,
  STOP_SEQUENCE_NOTICE,
  STOP_SEQUENCE_NOTICE_MARKER,
  StopSequenceStateStore,
  isStopSequenceNotice,
  stopSequenceFromEnv,
  withStopSequenceExtraBody,
} from "../stop-sequence.js";

test("stop sequence defaults to the precise forged-user header and can be disabled", () => {
  assert.equal(stopSequenceFromEnv(undefined), DEFAULT_STOP_SEQUENCE);
  assert.equal(DEFAULT_STOP_SEQUENCE, "user[消息时间");
  assert.equal(stopSequenceFromEnv("0"), null);
  assert.equal(stopSequenceFromEnv(""), null);
  assert.equal(stopSequenceFromEnv("\\nHuman:"), "\\nHuman:");
});

test("extra body merge preserves unrelated fields and de-duplicates stop sequences", () => {
  const raw = withStopSequenceExtraBody('{"thinking":{"display":"summarized"},"stop_sequences":["user<"]}', "user[消息时间");
  assert.deepEqual(JSON.parse(raw), {
    thinking: { display: "summarized" },
    stop_sequences: ["user<", "user[消息时间"],
  });
  const repeated = withStopSequenceExtraBody(raw, "user[消息时间");
  assert.deepEqual(JSON.parse(repeated).stop_sequences, ["user<", "user[消息时间"]);
});

test("extra body merge rejects malformed stop_sequences instead of silently guessing", () => {
  assert.throws(
    () => withStopSequenceExtraBody('{"stop_sequences":"user<"}', "user[消息时间"),
    /must be an array/,
  );
});

test("the phone-only guard notice has a stable recovery exclusion marker", () => {
  assert.match(STOP_SEQUENCE_NOTICE, /没有可安全显示的正文/);
  assert.equal(isStopSequenceNotice(STOP_SEQUENCE_NOTICE), true);
  assert.equal(isStopSequenceNotice(`HttpException: ${STOP_SEQUENCE_NOTICE}`), true);
  assert.equal(isStopSequenceNotice("正常正文"), false);
  assert.equal(STOP_SEQUENCE_NOTICE.includes(STOP_SEQUENCE_NOTICE_MARKER), true);
});

test("hit counter persists for the same native session and reads zero for a new one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-stop-seq-"));
  const file = path.join(dir, "state.json");
  const sessionA = "11111111-1111-4111-8111-111111111111";
  const sessionB = "22222222-2222-4222-8222-222222222222";
  try {
    const first = new StopSequenceStateStore({ file });
    assert.equal(first.forSession(sessionA).count, 0);
    assert.equal(first.recordHit(sessionA).count, 1);
    assert.equal(first.recordHit(sessionA).count, 2);

    const reloaded = new StopSequenceStateStore({ file });
    assert.equal(reloaded.forSession(sessionA).count, 2);
    assert.equal(reloaded.forSession(sessionB).count, 0);
    assert.equal(reloaded.recordHit(sessionB).count, 1);
    assert.equal(reloaded.forSession(sessionA).count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
