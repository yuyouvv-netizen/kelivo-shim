// One Claude turn can outlive a phone connection. Keep the generated text in
// memory and let a reconnecting identical request attach to the same turn.
export class ReplayableDelivery {
  constructor(sink) {
    this.sinks = new Set();
    this.fullText = "";
    this.finished = false;
    this.usage = undefined;
    if (sink) this.add(sink);
  }

  add(sink) {
    if (!sink) return false;
    if (this.fullText) sink.text?.(this.fullText);
    if (this.finished) {
      sink.finish?.(this.usage, this.fullText);
      return true;
    }
    this.sinks.add(sink);
    return true;
  }

  text(text) {
    if (this.finished || !text) return;
    this.fullText += text;
    for (const sink of this.sinks) {
      if (sink.isConnected?.() === false) continue;
      try { sink.text?.(text); } catch {}
    }
  }

  thinking(thinking) {
    if (this.finished || !thinking) return;
    for (const sink of this.sinks) {
      if (sink.isConnected?.() === false) continue;
      try { sink.thinking?.(thinking); } catch {}
    }
  }

  finish(usage, fullText) {
    if (this.finished) return false;
    this.finished = true;
    this.usage = usage;
    if (typeof fullText === "string" && !this.fullText) this.fullText = fullText;
    let delivered = false;
    for (const sink of this.sinks) {
      if (sink.isConnected?.() === false) continue;
      try {
        const result = sink.finish?.(usage, this.fullText);
        if (result !== false) delivered = true;
      } catch {}
    }
    this.sinks.clear();
    return delivered;
  }

  hasConnectedSink() {
    for (const sink of this.sinks) if (sink.isConnected?.() !== false) return true;
    return false;
  }
}
