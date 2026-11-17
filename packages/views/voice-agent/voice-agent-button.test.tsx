import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider, type NavigationAdapter } from "../navigation";
import { renderWithI18n } from "../test/i18n";
import type { VoiceAgentActionHandler, VoiceAgentSnapshot } from "./session";
import { VoiceAgentButton } from "./voice-agent-button";

const h = vi.hoisted(() => ({
  snap: { status: "off", error: null, heard: "", said: "" } as VoiceAgentSnapshot,
  handler: null as VoiceAgentActionHandler | null,
  start: vi.fn(),
  stop: vi.fn(),
  context: vi.fn(),
}));

vi.mock("./session", () => ({
  voiceAgent: {
    subscribe: () => () => {},
    getSnapshot: () => h.snap,
    start: h.start,
    stop: h.stop,
    setContext: h.context,
    setActionHandler: (fn: VoiceAgentActionHandler | null) => {
      h.handler = fn;
    },
  },
}));
vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "w1", name: "Work", slug: "work", issue_prefix: "WORK" }),
  };
});
vi.mock("@multica/core/inbox/queries", () => ({
  inboxListOptions: () => ({
    queryKey: ["inbox"],
    queryFn: async () => [
      { id: "n1", issue_id: null, title: "Quick create failed", type: "quick_create_failed", body: "timeout",
        created_at: "2026-11-17T10:00:00Z", read: false, archived: false },
    ],
  }),
}));
vi.mock("@multica/core/issues/queries", () => ({
  issueDetailOptions: () => ({ queryKey: ["issue"], queryFn: async () => { throw new Error("not an issue"); } }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  workspaceListOptions: () => ({
    queryKey: ["workspaces"],
    queryFn: async () => [
      { id: "w1", name: "Work", slug: "work", issue_prefix: "WORK" },
      { id: "w2", name: "Jake", slug: "jake", issue_prefix: "JAKE" },
    ],
  }),
}));

const push = vi.fn();
const nav = { pathname: "/work/issues", search: "" };

function renderButton(config: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(config), { status: 200 })));
  const adapter: NavigationAdapter = {
    push,
    replace: vi.fn(),
    back: vi.fn(),
    pathname: nav.pathname,
    searchParams: new URLSearchParams(nav.search),
    hash: "",
    getShareableUrl: (path) => path,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={adapter}>
        <VoiceAgentButton variant="bar" />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.snap = { status: "off", error: null, heard: "", said: "" };
  h.handler = null;
  nav.pathname = "/work/issues";
  nav.search = "";
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("VoiceAgentButton", () => {
  it("stays hidden when the server has no voice agent", async () => {
    const { container } = renderButton({ enabled: false, socket: null });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/voice/agent/config", { credentials: "same-origin" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("starts the agent on the server's socket and tells it the page", async () => {
    renderButton({ enabled: true, socket: "/voice/agent/ws" });
    fireEvent.click(await screen.findByRole("button", { name: "Talk to Multica" }));
    expect(h.start).toHaveBeenCalledWith("/voice/agent/ws");
    expect(h.context).toHaveBeenCalledWith(expect.objectContaining({ path: "/work/issues" }));
  });

  it("stops it when pressed while on, and shows what it heard and said", async () => {
    h.snap = { status: "listening", error: null, heard: "open my inbox", said: "Opened your inbox." };
    renderButton({ enabled: true, socket: "/voice/agent/ws" });
    const button = await screen.findByRole("button", { name: "Stop talking to Multica" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    expect(screen.getByText("open my inbox")).toBeInTheDocument();
    expect(screen.getByText("Opened your inbox.")).toBeInTheDocument();
    fireEvent.click(button);
    expect(h.stop).toHaveBeenCalled();
  });

  it("runs the agent's navigate action through the app's navigation", async () => {
    renderButton({ enabled: true, socket: "/voice/agent/ws" });
    await screen.findByRole("button", { name: "Talk to Multica" });
    await waitFor(async () => {
      const out = await h.handler!("navigate", { place: "issue", issue: "JAKE-386" }, () => true);
      expect(out).toEqual({ ok: true, went_to: "JAKE-386", workspace: "Jake" });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jake/issues/JAKE-386"));
    expect(await h.handler!("navigate", { place: "nowhere" }, () => true)).toEqual({ error: "unknown place nowhere" });
  });

  it("does not move the window for a conversation that has ended", async () => {
    renderButton({ enabled: true, socket: "/voice/agent/ws" });
    await screen.findByRole("button", { name: "Talk to Multica" });
    expect(await h.handler!("navigate", { place: "inbox" }, () => false)).toEqual({ error: "voice was turned off" });
    expect(await h.handler!("open_unread_inbox_item", {}, () => false)).toEqual({ error: "voice was turned off" });
    expect(push).not.toHaveBeenCalled();
  });

  it("reads an open inbox notification that has no issue", async () => {
    nav.pathname = "/work/inbox";
    nav.search = "issue=n1";
    renderButton({ enabled: true, socket: "/voice/agent/ws" });
    await screen.findByRole("button", { name: "Talk to Multica" });
    const out = await h.handler!("read_screen", {}, () => true);
    expect(out.inbox_item).toEqual({ title: "Quick create failed", kind: "quick_create_failed", detail: "timeout", at: "2026-11-17T10:00:00Z" });
    expect(out.issue).toBeUndefined();
  });

  it("still answers when the selection is an archived notification, not an issue", async () => {
    nav.pathname = "/work/inbox";
    nav.search = "view=archived&issue=gone";
    renderButton({ enabled: true, socket: "/voice/agent/ws" });
    await screen.findByRole("button", { name: "Talk to Multica" });
    const out = await h.handler!("read_screen", {}, () => true);
    expect(out).toMatchObject({ page: "/work/inbox", workspace: "Work" });
    expect(out.issue).toBeUndefined();
  });
});
