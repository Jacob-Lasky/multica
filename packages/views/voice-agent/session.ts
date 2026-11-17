/**
 * One live voice-agent conversation: microphone up, agent speech down, over
 * the same-origin socket the server's voice agent offers (`/voice/agent/config`).
 *
 * It is a module singleton on purpose, not component state: the conversation
 * stays on while the user moves around the app, including across workspace
 * switches that remount the dashboard layout. It holds live media objects, so
 * it is not a Zustand store either; components read it through
 * `useSyncExternalStore`.
 *
 * Wire (the server's voice/app/agent.py):
 *   up    binary PCM16 mono 16 kHz; JSON {type: hello|context|result}
 *   down  binary PCM16 mono 24 kHz; JSON {type: user|bot|tool|interrupt|action}
 */
import { loadPcmWorklet } from "../voice/deepgram-stream";
import { openMicrophone } from "../voice/recorder";
import { VOICE_AGENT_ACTIONS } from "./actions";

const IN_RATE = 16000;
const OUT_RATE = 24000;

export type VoiceAgentStatus = "off" | "connecting" | "listening" | "working" | "speaking";
export type VoiceAgentError = "busy" | "signed-out" | "microphone" | "failed" | null;

export interface VoiceAgentSnapshot {
  status: VoiceAgentStatus;
  error: VoiceAgentError;
  /** What the user is saying now, or last said. */
  heard: string;
  /** What the agent is saying now, or last said. */
  said: string;
}

export type VoiceAgentActionHandler = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface VoiceAgentContext {
  path: string;
  title: string;
  workspace: { slug: string; name: string; prefix: string } | null;
}

const CLOSE_ERRORS: Record<number, VoiceAgentError> = { 4401: "signed-out", 4403: "failed", 4429: "busy" };

interface Live {
  socket: WebSocket;
  audio: AudioContext;
  media: MediaStream | null;
  worklet: AudioWorkletNode | null;
  sources: Set<AudioBufferSourceNode>;
  playhead: number;
  speakingTimer: number | null;
}

class VoiceAgentSession {
  private snapshot: VoiceAgentSnapshot = { status: "off", error: null, heard: "", said: "" };
  private listeners = new Set<() => void>();
  private live: Live | null = null;
  private handler: VoiceAgentActionHandler | null = null;
  private context: VoiceAgentContext | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<VoiceAgentSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** The mounted button runs the agent's UI actions; the newest mount wins. */
  setActionHandler(handler: VoiceAgentActionHandler | null) {
    this.handler = handler;
    if (handler) return;
    // A remount (a workspace switch) mounts the next button right away; no
    // button soon after means the app shell is gone (sign-out), so hang up.
    window.setTimeout(() => {
      if (!this.handler && this.live) this.stop();
    }, 1000);
  }

  /** Where the user is now; sent on every change so the agent knows the screen. */
  setContext(context: VoiceAgentContext) {
    this.context = context;
    this.sendJson({ type: "context", ...context });
  }

  private sendJson(message: object) {
    const socket = this.live?.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  get active() {
    return this.live !== null;
  }

  /** Must run inside the user's click: browsers only let a gesture start audio. */
  async start(socketPath: string) {
    if (this.live) return;
    const audio = new AudioContext();
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    const url = new URL(socketPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const live: Live = {
      socket, audio, media: null, worklet: null, sources: new Set(), playhead: 0, speakingTimer: null,
    };
    this.live = live;
    this.set({ status: "connecting", error: null, heard: "", said: "" });

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.live !== live) return;
      if (typeof event.data === "string") {
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.onEvent(live, message);
      } else {
        this.play(live, event.data);
      }
    };
    socket.onclose = (event) => {
      if (this.live === live) this.stop(CLOSE_ERRORS[event.code] ?? (event.code === 1000 ? null : "failed"));
    };

    try {
      const [media] = await Promise.all([
        openMicrophone(null),
        loadPcmWorklet(audio),
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("close", () => reject(new Error("closed")), { once: true });
        }),
      ]);
      if (this.live !== live) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      live.media = media;
      const worklet = new AudioWorkletNode(audio, "pcm-downsampler", { processorOptions: { targetRate: IN_RATE } });
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
      };
      audio.createMediaStreamSource(media).connect(worklet);
      // A silent route to the speakers keeps every browser pulling audio through the worklet.
      const silence = audio.createGain();
      silence.gain.value = 0;
      worklet.connect(silence).connect(audio.destination);
      live.worklet = worklet;
      this.sendJson({ type: "hello", actions: VOICE_AGENT_ACTIONS });
      if (this.context) this.sendJson({ type: "context", ...this.context });
      this.set({ status: "listening" });
    } catch (err) {
      if (this.live !== live) return;
      const name = err instanceof Error || err instanceof DOMException ? err.name : "";
      const blocked = name === "NotAllowedError" || name === "SecurityError" || name === "NotFoundError";
      this.stop(blocked ? "microphone" : "failed");
    }
  }

  stop(error: VoiceAgentError = null) {
    const live = this.live;
    this.live = null;
    this.set({ status: "off", error });
    if (!live) return;
    if (live.speakingTimer !== null) window.clearTimeout(live.speakingTimer);
    live.worklet?.disconnect();
    live.media?.getTracks().forEach((track) => track.stop());
    live.socket.onclose = null;
    if (live.socket.readyState <= WebSocket.OPEN) live.socket.close(1000);
    void live.audio.close().catch(() => {});
  }

  private onEvent(live: Live, message: unknown) {
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    const text = typeof m.text === "string" ? m.text : "";
    switch (m.type) {
      case "user":
        // A final transcript is a finished turn: the agent works on it next.
        this.set(m.final === true ? { heard: text, status: "working", said: "" } : { heard: text });
        break;
      case "bot": {
        const said = this.snapshot.said;
        const joined = said && !/^[,.;:!?']/.test(text) ? `${said} ${text}` : said + text;
        this.set({ said: joined });
        break;
      }
      case "tool":
        this.set({ status: "working" });
        break;
      case "interrupt":
        this.flush(live);
        break;
      case "action":
        void this.runAction(m);
        break;
    }
  }

  private async runAction(m: Record<string, unknown>) {
    const id = String(m.id ?? "");
    const name = typeof m.name === "string" ? m.name : "";
    const args = m.args && typeof m.args === "object" ? (m.args as Record<string, unknown>) : {};
    let result: Record<string, unknown>;
    try {
      result = this.handler ? await this.handler(name, args) : { error: "Multica is not showing a page" };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "failed" };
    }
    this.sendJson({ type: "result", id, result });
  }

  private play(live: Live, data: ArrayBuffer) {
    const pcm = new Int16Array(data);
    if (!pcm.length) return;
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 0x8000;
    const buffer = live.audio.createBuffer(1, samples.length, OUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = live.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(live.audio.destination);
    const at = Math.max(live.audio.currentTime + 0.03, live.playhead);
    source.start(at);
    live.playhead = at + buffer.duration;
    live.sources.add(source);
    source.onended = () => live.sources.delete(source);
    if (this.snapshot.status !== "speaking") this.set({ status: "speaking" });
    // Back to listening once the queued speech has played out.
    if (live.speakingTimer !== null) window.clearTimeout(live.speakingTimer);
    live.speakingTimer = window.setTimeout(
      () => {
        live.speakingTimer = null;
        if (this.live === live && this.snapshot.status === "speaking") this.set({ status: "listening" });
      },
      (live.playhead - live.audio.currentTime) * 1000 + 100,
    );
  }

  private flush(live: Live) {
    for (const source of live.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    live.sources.clear();
    live.playhead = 0;
    if (this.snapshot.status === "speaking") this.set({ status: "listening" });
  }
}

export const voiceAgent = new VoiceAgentSession();
