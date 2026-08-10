import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplayableDelivery } from "../delivery.js";

function sink() {
  return {
    connected: true,
    textSeen: "",
    finished: 0,
    isConnected() { return this.connected; },
    text(value) { this.textSeen += value; },
    thinking() {},
    finish() { this.finished += 1; },
  };
}

test("identical reconnect receives the partial text and continues the same turn", () => {
  const first = sink();
  const delivery = new ReplayableDelivery(first);
  delivery.text("前半句");
  first.connected = false;

  const second = sink();
  delivery.add(second);
  assert.equal(second.textSeen, "前半句");
  delivery.text("后半句");
  assert.equal(first.textSeen, "前半句");
  assert.equal(second.textSeen, "前半句后半句");
  assert.equal(delivery.finish({ output_tokens: 2 }), true);
  assert.equal(second.finished, 1);
});

test("a completed turn with no connected phone is reported as undelivered", () => {
  const phone = sink();
  const delivery = new ReplayableDelivery(phone);
  delivery.text("已经完成的回复");
  phone.connected = false;
  assert.equal(delivery.finish(), false);
});
