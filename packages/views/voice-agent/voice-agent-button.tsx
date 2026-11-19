"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { TooltipHint } from "@multica/ui/components/common/tooltip-hint";
import { useCurrentWorkspace } from "@multica/core/paths";
import { workspaceListOptions } from "@multica/core/workspace/queries";
import { archivedInboxLookupOptions, inboxListOptions } from "@multica/core/inbox/queries";
import { ApiError } from "@multica/core/api";
import { issueDetailOptions } from "@multica/core/issues/queries";
import type { InboxItem, Workspace } from "@multica/core/types";
import { useT } from "../i18n";
import { BOTTOM_BAR_ICON_ITEM_CLASS } from "../layout/bottom-bar-styles";
import { useNavigation } from "../navigation";
import { clip, inboxItemPath, issueOnScreen, newestUnread, resolveNavigate } from "./actions";
import { voiceAgent, type VoiceAgentSnapshot } from "./session";

interface VoiceAgentConfig {
  enabled: boolean;
  socket: string | null;
}

/**
 * Whether this server runs a voice agent for the signed-in user. The agent is
 * an optional same-origin service: no answer, or any failure, means no button.
 */
function useVoiceAgentConfig(): VoiceAgentConfig | null {
  const { data } = useQuery({
    queryKey: ["voice-agent", "config"],
    queryFn: async (): Promise<VoiceAgentConfig> => {
      const r = await fetch("/voice/agent/config", { credentials: "same-origin" });
      if (!r.ok) return { enabled: false, socket: null };
      const body: unknown = await r.json();
      const b = (body ?? {}) as Partial<VoiceAgentConfig>;
      return { enabled: b.enabled === true, socket: typeof b.socket === "string" ? b.socket : null };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data ?? null;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "failed";
}

function useVoiceAgentSnapshot(): VoiceAgentSnapshot {
  return useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getSnapshot, voiceAgent.getSnapshot);
}

/** Runs the agent's UI actions against this window: navigation, the inbox, what is on screen. */
function useVoiceAgentActions(current: Workspace | null) {
  const nav = useNavigation();
  const qc = useQueryClient();
  const { data: workspaces = [] } = useQuery(workspaceListOptions());
  const { pathname, searchParams } = nav;

  // The agent always knows the page the user is on.
  useEffect(() => {
    const search = searchParams.toString();
    voiceAgent.setContext({
      path: search ? `${pathname}?${search}` : pathname,
      title: typeof document === "undefined" ? "" : document.title,
      workspace: current ? { slug: current.slug, name: current.name, prefix: current.issue_prefix } : null,
    });
  }, [pathname, searchParams, current]);

  const run = useCallback(
    async (
      name: string,
      args: Record<string, unknown>,
      live: () => boolean,
    ): Promise<Record<string, unknown>> => {
      if (!current) return { error: "no workspace is open" };
      switch (name) {
        case "navigate": {
          const target = resolveNavigate(args, current, workspaces);
          if (!target.ok) return { error: target.error };
          if (!live()) return { error: "voice was turned off" };
          nav.push(target.path);
          return { ok: true, went_to: target.where, workspace: target.workspace };
        }
        case "open_unread_inbox_item": {
          const items = await qc.fetchQuery({ ...inboxListOptions(current.id), staleTime: 0 });
          const { item, unread } = newestUnread(items);
          if (!item) return { ok: true, unread: 0, workspace: current.name };
          if (!live()) return { error: "voice was turned off" };
          nav.push(inboxItemPath(current, item));
          return {
            ok: true,
            opened: { title: item.title, kind: item.type, detail: clip(item.body, 300), at: item.created_at },
            unread_left: unread - 1,
            workspace: current.name,
          };
        }
        case "read_screen": {
          const screen: Record<string, unknown> = {
            page: pathname,
            title: document.title,
            workspace: current.name,
          };
          const onScreen = issueOnScreen(pathname, searchParams);
          let issueRef = onScreen && !onScreen.byId ? onScreen.ref : null;
          // A raw inbox key (no row found in either list) may be a notification id, not an issue:
          // only then is a 404 from the issue lookup expected.
          let rawInboxKey = false;
          if (onScreen?.byId) {
            // The inbox selects by issue id, or by the notification's own id when it has no issue.
            const sameKey = (i: InboxItem) => (i.issue_id ?? i.id) === onScreen.ref;
            let row = (await qc.fetchQuery(inboxListOptions(current.id))).find(sameKey);
            if (!row && searchParams.get("view") === "archived") {
              try {
                const page = await qc.fetchQuery(archivedInboxLookupOptions(current.id, onScreen.ref));
                row = page.items.find(sameKey);
              } catch (err) {
                if (!isNotFound(err)) screen.inbox_error = errorMessage(err);
              }
            }
            if (row) {
              screen.inbox_item = { title: row.title, kind: row.type, detail: clip(row.body, 300), at: row.created_at };
              issueRef = row.issue_id;
            } else {
              issueRef = onScreen.ref;
              rawInboxKey = true;
            }
          }
          if (issueRef) {
            try {
              const issue = await qc.fetchQuery(issueDetailOptions(current.id, issueRef));
              screen.issue = {
                id: issue.identifier,
                title: issue.title,
                status: issue.status,
                priority: issue.priority,
                description: clip(issue.description, 800),
              };
            } catch (err) {
              // Expected only for a raw inbox key that names a notification; anything else the agent should say.
              if (!(rawInboxKey && isNotFound(err))) screen.issue_error = errorMessage(err);
            }
          }
          return screen;
        }
        default:
          return { error: `unknown action ${name}` };
      }
    },
    [current, workspaces, nav, qc, pathname, searchParams],
  );

  useEffect(() => {
    voiceAgent.setActionHandler(run);
  }, [run]);
  // Leaving the dashboard entirely (sign-out) ends the conversation.
  useEffect(() => () => voiceAgent.setActionHandler(null), []);
}

/**
 * The voice agent's switch: one press turns it on, and it stays on, listening,
 * while the user moves around the app, until pressed again. It renders at the
 * left end of the bottom bar from `md` up, and below `md` as a floating button
 * in the bottom-left corner, the mirror image of the quick chat launcher.
 */
export function VoiceAgentButton({ variant }: { variant: "bar" | "floating" }) {
  const { t } = useT("layout");
  const config = useVoiceAgentConfig();
  const current = useCurrentWorkspace();
  const snap = useVoiceAgentSnapshot();
  useVoiceAgentActions(current);

  if (!config?.enabled || !config.socket) return null;
  const socket = config.socket;
  const on = snap.status !== "off";
  const label = on ? t(($) => $.voice_agent.stop) : t(($) => $.voice_agent.start);
  const toggle = () => (on ? voiceAgent.stop() : void voiceAgent.start(socket));

  return (
    <>
      <TooltipHint label={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={on}
          onClick={toggle}
          data-voice-agent={snap.status}
          className={cn(
            variant === "bar"
              ? // -ml-2: the first item of the bar, its icon on the bar's left gutter.
                cn(BOTTOM_BAR_ICON_ITEM_CLASS, "-ml-2")
              : // eslint-disable-next-line no-restricted-syntax -- a launcher: the same round button as the chat launcher, on its row in the opposite corner
                "fixed left-[var(--chat-launcher-inset)] bottom-[var(--chat-launcher-inset)] z-50 flex size-[var(--chat-launcher-size)] items-center justify-center rounded-full bg-surface-raised text-muted-foreground shadow-[var(--floating-shadow)] ring-1 ring-surface-border",
            on && "text-brand",
            on && snap.status !== "listening" && "animate-chat-impulse",
          )}
        >
          <Mic className={variant === "floating" ? "size-5" : undefined} />
        </button>
      </TooltipHint>
      <VoiceAgentCaption snap={snap} variant={variant} />
    </>
  );
}

/** A small live caption while the agent is on, or its last error. */
function VoiceAgentCaption({ snap, variant }: { snap: VoiceAgentSnapshot; variant: "bar" | "floating" }) {
  const { t } = useT("layout");
  if (snap.status === "off" && !snap.error) return null;
  const status =
    snap.status === "off"
      ? t(($) => $.voice_agent.errors[snap.error ?? "failed"])
      : t(($) => $.voice_agent.status[snap.status as Exclude<typeof snap.status, "off">]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="voice-agent-caption"
      className={cn(
        "fixed left-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-surface-raised p-3 text-caption shadow-[var(--floating-shadow)] ring-1 ring-surface-border",
        variant === "bar" ? "bottom-10" : "bottom-[calc(var(--chat-launcher-inset)+var(--chat-launcher-size)+0.75rem)]",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span className="font-medium">{status}</span>
        {snap.status === "off" && (
          <button type="button" className="underline" onClick={() => voiceAgent.stop()}>
            {t(($) => $.voice_agent.dismiss)}
          </button>
        )}
      </div>
      {snap.heard && <p className="mt-1.5 text-right text-foreground/70">{snap.heard}</p>}
      {snap.said && <p className="mt-1 text-foreground">{snap.said}</p>}
    </div>
  );
}
