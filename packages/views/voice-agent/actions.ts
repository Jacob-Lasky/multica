/**
 * The voice agent's UI actions, resolved to app paths. Pure: the button
 * supplies the workspaces and inbox it already has, so this is testable alone.
 *
 * The agent only ever names a place, an issue identifier or a workspace name;
 * the URL is always built here from the app's own route table. Do not accept
 * a raw path or URL from the agent: text it read in an issue could otherwise
 * send the browser anywhere.
 */
import { paths, type WorkspacePaths } from "@multica/core/paths";
import type { InboxItem, Workspace } from "@multica/core/types";

export const VOICE_AGENT_ACTIONS = ["navigate", "open_unread_inbox_item", "read_screen", "go_back"] as const;
export type VoiceAgentActionName = (typeof VOICE_AGENT_ACTIONS)[number];

const PLACES: Record<string, (p: WorkspacePaths) => string> = {
  inbox: (p) => p.inbox(),
  my_issues: (p) => p.myIssues(),
  issues: (p) => p.issues(),
  projects: (p) => p.projects(),
  agents: (p) => p.agents(),
  chat: (p) => p.chat(),
  runtimes: (p) => p.runtimes(),
  autopilots: (p) => p.autopilots(),
  skills: (p) => p.skills(),
  settings: (p) => p.settings(),
};

const ISSUE_RE = /^([A-Za-z]+)-(\d+)$/;

export type NavigateResult =
  | { ok: true; path: string; workspace: string; where: string }
  | { ok: false; error: string };

function findWorkspace(workspaces: readonly Workspace[], spoken: string): Workspace | undefined {
  const want = spoken.trim().toLowerCase();
  return (
    workspaces.find((w) => w.name.toLowerCase() === want || w.slug.toLowerCase() === want) ??
    workspaces.find((w) => w.issue_prefix.toLowerCase() === want) ??
    workspaces.find((w) => w.name.toLowerCase().includes(want))
  );
}

/** Where `navigate` goes, or why it cannot. */
export function resolveNavigate(
  args: Record<string, unknown>,
  current: Workspace,
  workspaces: readonly Workspace[],
): NavigateResult {
  const place = typeof args.place === "string" ? args.place : "";
  const spokenWs = typeof args.workspace === "string" ? args.workspace : "";
  let target = current;
  if (spokenWs) {
    const found = findWorkspace(workspaces, spokenWs);
    if (!found) {
      return { ok: false, error: `no workspace called ${spokenWs}; there are ${workspaces.map((w) => w.name).join(", ")}` };
    }
    target = found;
  }
  if (place === "issue") {
    const m = ISSUE_RE.exec(typeof args.issue === "string" ? args.issue : "");
    if (!m) return { ok: false, error: "no issue number" };
    const prefix = m[1]!.toUpperCase();
    // An issue number names its workspace: JAKE-12 lives where the prefix is JAKE.
    if (!spokenWs && target.issue_prefix.toUpperCase() !== prefix) {
      const owner = workspaces.find((w) => w.issue_prefix.toUpperCase() === prefix);
      if (!owner) return { ok: false, error: `no workspace uses the prefix ${prefix}` };
      target = owner;
    }
    const identifier = `${prefix}-${Number(m[2])}`;
    return {
      ok: true,
      path: paths.workspace(target.slug).issueDetail(identifier),
      workspace: target.name,
      where: identifier,
    };
  }
  const build = Object.hasOwn(PLACES, place) ? PLACES[place] : undefined;
  if (!build) return { ok: false, error: `unknown place ${place}` };
  return { ok: true, path: build(paths.workspace(target.slug)), workspace: target.name, where: place.replace("_", " ") };
}

/** The newest unread, unarchived inbox row (one per issue, as the inbox shows them). */
export function newestUnread(items: readonly InboxItem[]): { item: InboxItem | null; unread: number } {
  const unread = items.filter((i) => !i.read && !i.archived);
  const byIssue = new Map<string, InboxItem>();
  for (const item of unread) {
    const key = item.issue_id ?? item.id;
    const seen = byIssue.get(key);
    if (!seen || seen.created_at < item.created_at) byIssue.set(key, item);
  }
  const rows = [...byIssue.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { item: rows[0] ?? null, unread: rows.length };
}

/** The inbox address that opens one row: the same `?issue=` key the inbox page selects by. */
export function inboxItemPath(workspace: Workspace, item: InboxItem): string {
  return `${paths.workspace(workspace.slug).inbox()}?issue=${encodeURIComponent(item.issue_id ?? item.id)}`;
}

/** The issue a path shows, if any: `/ws/issues/JAKE-1`, or the inbox with `?issue=`. */
export function issueOnScreen(pathname: string, search: URLSearchParams): { ref: string; byId: boolean } | null {
  const detail = /^\/[^/]+\/issues\/([^/]+)$/.exec(pathname);
  if (detail) return { ref: decodeURIComponent(detail[1]!), byId: false };
  if (/^\/[^/]+\/inbox$/.test(pathname)) {
    const key = search.get("issue");
    if (key) return { ref: key, byId: true };
  }
  return null;
}

export function clip(text: string | null | undefined, max: number): string {
  const flat = (text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
