import { describe, it, expect, beforeEach, vi } from "vitest";

// Inbox is in-memory only, need fresh module state per test
let pushInbox, unreadCount, readInbox, allInbox, inboxPromptHint;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../../../src/memory/inbox.js");
  pushInbox = mod.pushInbox;
  unreadCount = mod.unreadCount;
  readInbox = mod.readInbox;
  allInbox = mod.allInbox;
  inboxPromptHint = mod.inboxPromptHint;
});

describe("pushInbox", () => {
  it("adds notification to inbox", () => {
    pushInbox("reminder", "Check deploy status", "schedule");
    expect(unreadCount()).toBe(1);
    const items = allInbox();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("reminder");
    expect(items[0].content).toBe("Check deploy status");
    expect(items[0].from).toBe("schedule");
    expect(items[0].read).toBe(false);
  });
});

describe("unreadCount", () => {
  it("returns correct count of unread items", () => {
    pushInbox("reminder", "first");
    pushInbox("message", "second");
    pushInbox("event", "third");
    expect(unreadCount()).toBe(3);
  });

  it("returns 0 when inbox is empty", () => {
    expect(unreadCount()).toBe(0);
  });
});

describe("readInbox", () => {
  it("returns unread items and marks them as read", () => {
    pushInbox("reminder", "task A");
    pushInbox("message", "task B");
    const unread = readInbox();
    expect(unread).toHaveLength(2);
    expect(unread[0].content).toBe("task A");
    expect(unreadCount()).toBe(0);
  });

  it("second call returns empty after all read", () => {
    pushInbox("reminder", "once");
    readInbox();
    const second = readInbox();
    expect(second).toHaveLength(0);
  });
});

describe("allInbox", () => {
  it("returns all items including read ones", () => {
    pushInbox("reminder", "item 1");
    pushInbox("message", "item 2");
    readInbox(); // mark all as read
    pushInbox("event", "item 3"); // new unread
    const all = allInbox();
    expect(all).toHaveLength(3);
    expect(all[0].read).toBe(true);
    expect(all[1].read).toBe(true);
    expect(all[2].read).toBe(false);
  });
});

describe("inboxPromptHint", () => {
  it("returns hint string when unread notifications exist", () => {
    pushInbox("reminder", "check logs");
    pushInbox("reminder", "review PR");
    pushInbox("message", "from admin");
    const hint = inboxPromptHint();
    expect(hint).toContain("3 unread notifications");
    expect(hint).toContain("2 reminders");
    expect(hint).toContain("1 message");
    expect(hint).toContain("check_inbox");
  });

  it("returns null when no unread notifications", () => {
    expect(inboxPromptHint()).toBeNull();
  });

  it("returns null after all notifications are read", () => {
    pushInbox("event", "deploy done");
    readInbox();
    expect(inboxPromptHint()).toBeNull();
  });
});
