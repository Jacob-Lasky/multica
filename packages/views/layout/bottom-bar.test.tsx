import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider, type NavigationAdapter } from "../navigation";
import { renderWithI18n } from "../test/i18n";
import { AppBottomBar } from "./bottom-bar";

interface TeamStatus {
  working: { id: string }[];
  stuck: { id: string }[];
  byAgent: Map<string, { queuedCount: number }>;
}

const h = vi.hoisted(() => ({
  chat: { floatingChatEnabled: true, isOpen: false },
  isMobile: false,
  workspace: { id: "ws-test" } as { id: string } | null,
  team: { working: [], stuck: [], byAgent: new Map() } as TeamStatus,
}));

vi.mock("@multica/core/chat", () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof h.chat) => unknown) => selector(h.chat),
    { getState: () => h.chat },
  ),
}));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => h.workspace,
  useWorkspacePaths: () => ({ chat: () => "/acme/chat", agents: () => "/acme/agents" }),
}));
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsMobile: () => h.isMobile }));
vi.mock("./panels/team-status", () => ({ useTeamAgentStatus: () => h.team }));
vi.mock("./app-shell-context", () => ({ useAppShell: () => null }));
vi.mock("../chat/components/chat-bar", () => ({ ChatBar: () => <div data-testid="chat-bar" /> }));
vi.mock("../voice-agent/voice-agent-button", () => ({
  VoiceAgentButton: ({ variant }: { variant: string }) => <div data-testid={`voice-agent-${variant}`} />,
}));

function renderBar(pathname = "/acme/issues") {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => path,
  };
  return renderWithI18n(
    <NavigationProvider value={adapter}>
      <AppBottomBar />
    </NavigationProvider>,
  );
}

beforeEach(() => {
  h.chat.floatingChatEnabled = true;
  h.chat.isOpen = false;
  h.isMobile = false;
  h.workspace = { id: "ws-test" };
  h.team = { working: [], stuck: [], byAgent: new Map() };
});

describe("AppBottomBar", () => {
  it("shows quick chat and no team status while the team is idle", () => {
    renderBar();

    expect(screen.getByRole("contentinfo", { name: "Status bar" })).toBeInTheDocument();
    expect(screen.getByTestId("chat-bar")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps quick chat without a working-agent entry when agents are running", () => {
    h.team.working = [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4" }];
    renderBar();

    expect(screen.queryByText("4 agents working")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-bar")).toBeInTheDocument();
  });

  it("adds up the tasks waiting on offline runtimes across agents", () => {
    h.team.stuck = [{ id: "a1" }, { id: "a2" }];
    h.team.byAgent = new Map([
      ["a1", { queuedCount: 2 }],
      ["a2", { queuedCount: 1 }],
    ]);
    renderBar();

    expect(
      screen.getByRole("link", { name: "3 tasks waiting on an offline runtime" }),
    ).toHaveAttribute("href", "/acme/agents");
  });

  it("drops quick chat on the Chat tab, which already shows it full-page", () => {
    renderBar("/acme/chat");
    expect(screen.queryByTestId("chat-bar")).not.toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("drops quick chat when the floating chat preference is off", () => {
    h.chat.floatingChatEnabled = false;
    renderBar();

    expect(screen.queryByTestId("chat-bar")).not.toBeInTheDocument();
  });

  it("renders nothing without a workspace", () => {
    h.workspace = null;
    expect(renderBar().container).toBeEmptyDOMElement();
  });

  it("puts the voice agent in the bar, and floating below md where there is no bar", () => {
    const { unmount } = renderBar();
    expect(screen.getByTestId("voice-agent-bar")).toBeInTheDocument();
    unmount();

    h.isMobile = true;
    renderBar();
    expect(screen.getByTestId("voice-agent-floating")).toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it("puts the voice agent at the left end of the bar, before team status and quick chat", () => {
    h.team.stuck = [{ id: "a1" }];
    h.team.byAgent = new Map([["a1", { queuedCount: 1 }]]);
    renderBar();
    const voice = screen.getByTestId("voice-agent-bar");
    const status = screen.getByRole("link");
    const chat = screen.getByTestId("chat-bar");
    expect(voice.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the floating voice agent below md while quick chat is open, so it never covers the composer", () => {
    h.isMobile = true;
    h.chat.isOpen = true;
    const { unmount } = renderBar();
    expect(screen.queryByTestId("voice-agent-floating")).not.toBeInTheDocument();
    unmount();

    // An open flag with the floating window turned off shows no window.
    h.chat.floatingChatEnabled = false;
    renderBar();
    expect(screen.getByTestId("voice-agent-floating")).toBeInTheDocument();
  });

  it("hides the floating voice agent on the Chat tab, whose composer spans the phone", () => {
    h.isMobile = true;
    renderBar("/acme/chat");
    expect(screen.queryByTestId("voice-agent-floating")).not.toBeInTheDocument();
  });
});
