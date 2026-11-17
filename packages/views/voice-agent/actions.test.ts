// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem, Workspace } from "@multica/core/types";
import { inboxItemPath, issueOnScreen, newestUnread, resolveNavigate } from "./actions";

const ws = (name: string, slug: string, prefix: string) => ({ id: slug, name, slug, issue_prefix: prefix }) as Workspace;
const WORK = ws("Work", "work", "WORK");
const JAKE = ws("Jake", "jake", "JAKE");
const ALL = [WORK, JAKE];

const item = (id: string, at: string, extra: Partial<InboxItem> = {}) =>
  ({ id, issue_id: null, read: false, archived: false, created_at: at, title: id, ...extra }) as InboxItem;

describe("resolveNavigate", () => {
  it("goes to a place in the current workspace", () => {
    expect(resolveNavigate({ place: "inbox" }, WORK, ALL)).toEqual({
      ok: true, path: "/work/inbox", workspace: "Work", where: "inbox",
    });
    expect(resolveNavigate({ place: "my_issues" }, WORK, ALL)).toMatchObject({ path: "/work/my-issues" });
  });

  it("switches workspace when one is named", () => {
    expect(resolveNavigate({ place: "inbox", workspace: "jake" }, WORK, ALL)).toMatchObject({ path: "/jake/inbox" });
    expect(resolveNavigate({ place: "inbox", workspace: "Nope" }, WORK, ALL)).toMatchObject({ ok: false });
  });

  it("follows an issue's prefix to its workspace", () => {
    expect(resolveNavigate({ place: "issue", issue: "JAKE-386" }, WORK, ALL)).toEqual({
      ok: true, path: "/jake/issues/JAKE-386", workspace: "Jake", where: "JAKE-386",
    });
    expect(resolveNavigate({ place: "issue", issue: "ZZZ-1" }, WORK, ALL)).toMatchObject({ ok: false });
  });

  it("never builds a path from anything but a known place or a clean identifier", () => {
    expect(resolveNavigate({ place: "https://evil.example" }, WORK, ALL)).toMatchObject({ ok: false });
    expect(resolveNavigate({ place: "issue", issue: "../../admin" }, WORK, ALL)).toMatchObject({ ok: false });
    expect(resolveNavigate({ place: "__proto__" }, WORK, ALL)).toMatchObject({ ok: false });
  });
});

describe("newestUnread", () => {
  it("picks the newest unread row, one per issue, skipping read and archived", () => {
    const items = [
      item("a", "2026-11-17T10:00:00Z", { issue_id: "i1" }),
      item("b", "2026-11-17T12:00:00Z", { issue_id: "i1" }),
      item("c", "2026-11-17T11:00:00Z"),
      item("d", "2026-11-17T13:00:00Z", { read: true }),
      item("e", "2026-11-17T14:00:00Z", { archived: true }),
    ];
    const { item: newest, unread } = newestUnread(items);
    expect(newest?.id).toBe("b");
    expect(unread).toBe(2);
    expect(newestUnread([])).toEqual({ item: null, unread: 0 });
  });

  it("opens a row by the key the inbox selects by", () => {
    expect(inboxItemPath(WORK, item("n1", "x", { issue_id: "uuid-1" }))).toBe("/work/inbox?issue=uuid-1");
    expect(inboxItemPath(WORK, item("n1", "x"))).toBe("/work/inbox?issue=n1");
  });
});

describe("issueOnScreen", () => {
  it("reads the issue from its page or from the inbox selection", () => {
    expect(issueOnScreen("/jake/issues/JAKE-1", new URLSearchParams())).toEqual({ ref: "JAKE-1", byId: false });
    expect(issueOnScreen("/jake/inbox", new URLSearchParams("issue=u1"))).toEqual({ ref: "u1", byId: true });
    expect(issueOnScreen("/jake/inbox", new URLSearchParams())).toBeNull();
    expect(issueOnScreen("/jake/projects", new URLSearchParams())).toBeNull();
  });
});
