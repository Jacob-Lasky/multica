import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  trackStop: vi.fn(),
  workletFails: false,
}));

vi.mock("../voice/recorder", () => ({
  openMicrophone: async () => ({ getTracks: () => [{ stop: h.trackStop }] }),
}));
vi.mock("../voice/deepgram-stream", () => ({ loadPcmWorklet: async () => { if (h.workletFails) throw new Error("no worklet"); } }));

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: URL) {
    super();
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  async resume() {}
  async close() {}
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => ({}) };
  }
}

class FakeWorkletNode {
  port = { onmessage: null };
  connect() {
    return { connect: () => {} };
  }
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  h.trackStop.mockClear();
  h.workletFails = false;
});
afterEach(() => vi.unstubAllGlobals());

async function freshSession() {
  vi.resetModules();
  return (await import("./session")).voiceAgent;
}

describe("voiceAgent", () => {
  it("releases the microphone when the worklet fails after the mic opened", async () => {
    h.workletFails = true;
    const agent = await freshSession();
    await agent.start("/voice/agent/ws");
    expect(agent.getSnapshot()).toMatchObject({ status: "off", error: "failed" });
    expect(h.trackStop).toHaveBeenCalled();
  });

  it("says hello with its actions once the socket opens", async () => {
    const agent = await freshSession();
    const started = agent.start("/voice/agent/ws");
    FakeSocket.last!.open();
    await started;
    expect(agent.getSnapshot().status).toBe("listening");
    expect(JSON.parse(FakeSocket.last!.sent[0]!)).toEqual({
      type: "hello",
      actions: ["navigate", "open_unread_inbox_item", "read_screen"],
    });
    agent.stop();
  });

  it("answers an action only on the conversation that asked, and tells the handler when it ended", async () => {
    const agent = await freshSession();
    let release: () => void = () => {};
    let liveAfter: boolean | null = null;
    agent.setActionHandler(async (_name, _args, live) => {
      await new Promise<void>((r) => (release = r));
      liveAfter = live();
      return { ok: true };
    });
    const started = agent.start("/voice/agent/ws");
    const first = FakeSocket.last!;
    first.open();
    await started;
    first.receive({ type: "action", id: "1", name: "navigate", args: { place: "inbox" } });
    agent.stop();
    const restarted = agent.start("/voice/agent/ws");
    const second = FakeSocket.last!;
    second.open();
    await restarted;
    release();
    await vi.waitFor(() => expect(liveAfter).toBe(false));
    expect(first.sent.some((m) => m.includes('"result"'))).toBe(false);
    expect(second.sent.some((m) => m.includes('"result"'))).toBe(false);
    agent.stop();
  });
});
