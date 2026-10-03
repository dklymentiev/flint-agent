import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createSessionSlice } from "../../src/store/session-slice.js";
import { createAgentSlice } from "../../src/store/agent-slice.js";
import { createUiSlice } from "../../src/store/ui-slice.js";
import { createDatasetSlice } from "../../src/store/dataset-slice.js";
import { createTmpDir } from "../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";

// Mock config for session save/load (must be before dynamic import)
vi.mock("../../src/config.js", () => ({
  config: {
    get sessionsDir() {
      return globalThis.__testSessionsDir;
    },
  },
}));

const { saveSession, loadSession } = await import("../../src/sessions.js");

// Helper: create a full store with all relevant slices
function makeStore() {
  return createStore((...args) => ({
    ...createSessionSlice(...args),
    ...createAgentSlice(...args),
    ...createUiSlice(...args),
    ...createDatasetSlice(...args),
  }));
}

let tmp;

beforeEach(() => {
  tmp = createTmpDir();
  globalThis.__testSessionsDir = path.join(tmp.path, "sessions");
  fs.mkdirSync(globalThis.__testSessionsDir);
});

afterEach(() => {
  tmp.cleanup();
});

// ── 1. Session save/load ────────────────────────────────────

describe("session save/load", () => {
  it("saves and loads messages through store round-trip", async () => {
    const store = makeStore();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ];
    store.getState().setSession("func-test-1", messages, ["Hello", "How are you?"]);

    const s = store.getState();
    await saveSession("func-test-1", {
      messages: s.messages,
      model: "test-model",
      inputHistory: s.inputHistory,
    });

    const loaded = await loadSession("func-test-1");
    expect(loaded.messages).toEqual(messages);
    expect(loaded.inputHistory).toEqual(["Hello", "How are you?"]);
  });

  it("preserves message order and content after save/load", async () => {
    const store = makeStore();
    store.getState().setSession("order-test", [], []);
    store.getState().pushMessage({ role: "user", content: "first" });
    store.getState().pushMessage({ role: "assistant", content: "second" });
    store.getState().pushMessage({ role: "user", content: "third" });

    const s = store.getState();
    await saveSession("order-test", { messages: s.messages, model: "m", inputHistory: [] });

    const loaded = await loadSession("order-test");
    expect(loaded.messages).toHaveLength(3);
    expect(loaded.messages[0].content).toBe("first");
    expect(loaded.messages[1].content).toBe("second");
    expect(loaded.messages[2].content).toBe("third");
  });

  it("loads session back into a fresh store with setSession", async () => {
    const messages = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ];
    await saveSession("reload-test", { messages, model: "m", inputHistory: ["ping"] });

    const loaded = await loadSession("reload-test");
    const store2 = makeStore();
    store2.getState().setSession(loaded.id, loaded.messages, loaded.inputHistory);

    const s = store2.getState();
    expect(s.sessionId).toBe("reload-test");
    expect(s.messages).toEqual(messages);
    expect(s.inputHistory).toEqual(["ping"]);
    expect(s.userMessageCount).toBe(1);
  });
});

// ── 2. Agent slice: status transitions ──────────────────────

describe("agent status transitions", () => {
  it("transitions idle → thinking → calling-tool → streaming → idle", () => {
    const store = makeStore();

    expect(store.getState().agentStatus).toBe("idle");
    expect(store.getState()._startedAt).toBeUndefined();

    store.getState().setAgentStatus("thinking");
    expect(store.getState().agentStatus).toBe("thinking");
    expect(store.getState()._startedAt).toBeTypeOf("number");

    const ts = store.getState()._startedAt;

    store.getState().setAgentStatus("calling-tool", "read_file");
    expect(store.getState().agentStatus).toBe("calling-tool");
    expect(store.getState().currentTool).toBe("read_file");
    // _startedAt should remain the same (already set)
    expect(store.getState()._startedAt).toBe(ts);

    store.getState().setAgentStatus("streaming");
    expect(store.getState().agentStatus).toBe("streaming");

    store.getState().setAgentStatus("idle");
    expect(store.getState().agentStatus).toBe("idle");
    expect(store.getState()._startedAt).toBeNull();
    expect(store.getState().currentTool).toBeNull();
  });

  it("clears _startedAt on idle and re-sets on next non-idle", () => {
    const store = makeStore();
    store.getState().setAgentStatus("thinking");
    const ts1 = store.getState()._startedAt;
    expect(ts1).toBeTypeOf("number");

    store.getState().setAgentStatus("idle");
    expect(store.getState()._startedAt).toBeNull();

    store.getState().setAgentStatus("streaming");
    const ts2 = store.getState()._startedAt;
    expect(ts2).toBeTypeOf("number");
    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });
});

// ── 3. Dataset management ───────────────────────────────────

describe("dataset management", () => {
  it("adds a dataset and retrieves page 1", () => {
    const store = makeStore();
    const id = store.getState().addDataset({
      label: "users",
      columns: ["name", "age"],
      rows: [["Alice", 30], ["Bob", 25], ["Carol", 35]],
      pageSize: 2,
    });

    const page = store.getState().getDatasetPage(id);
    expect(page.label).toBe("users");
    expect(page.rows).toEqual([["Alice", 30], ["Bob", 25]]);
    expect(page.page).toBe(1);
    expect(page.totalPages).toBe(2);
    expect(page.totalRows).toBe(3);
  });

  it("paginates next/prev correctly", () => {
    const store = makeStore();
    const id = store.getState().addDataset({
      label: "data",
      columns: ["v"],
      rows: Array.from({ length: 25 }, (_, i) => [i]),
      pageSize: 10,
    });

    // Page 1
    let page = store.getState().getDatasetPage(id);
    expect(page.rows).toHaveLength(10);
    expect(page.rows[0][0]).toBe(0);

    // Next → page 2
    store.getState().setDatasetPage(id, 2);
    page = store.getState().getDatasetPage(id);
    expect(page.page).toBe(2);
    expect(page.rows[0][0]).toBe(10);

    // Next → page 3 (last)
    store.getState().setDatasetPage(id, 3);
    page = store.getState().getDatasetPage(id);
    expect(page.page).toBe(3);
    expect(page.rows).toHaveLength(5);

    // Beyond last → clamped to 3
    store.getState().setDatasetPage(id, 99);
    page = store.getState().getDatasetPage(id);
    expect(page.page).toBe(3);

    // Before first → clamped to 1
    store.getState().setDatasetPage(id, -5);
    page = store.getState().getDatasetPage(id);
    expect(page.page).toBe(1);
  });

  it("evicts oldest dataset when at max capacity", () => {
    const store = makeStore();
    const ids = [];
    // Add 11 datasets (MAX_DATASETS = 10)
    for (let i = 0; i < 11; i++) {
      ids.push(
        store.getState().addDataset({
          label: `ds-${i}`,
          columns: ["x"],
          rows: [[i]],
        })
      );
    }

    const datasets = store.getState().datasets;
    expect(Object.keys(datasets)).toHaveLength(10);
    // First dataset should have been evicted
    expect(datasets[ids[0]]).toBeUndefined();
    // Last dataset should exist
    expect(datasets[ids[10]]).toBeDefined();
  });
});

// ── 4. Input history ────────────────────────────────────────

describe("input history", () => {
  it("pushes entries in order", () => {
    const store = makeStore();
    store.getState().pushInputHistory("first");
    store.getState().pushInputHistory("second");
    store.getState().pushInputHistory("third");
    expect(store.getState().inputHistory).toEqual(["first", "second", "third"]);
  });

  it("preserves history through setSession", () => {
    const store = makeStore();
    store.getState().pushInputHistory("a");
    store.getState().pushInputHistory("b");

    // setSession replaces inputHistory
    store.getState().setSession("s1", [], ["x", "y", "z"]);
    expect(store.getState().inputHistory).toEqual(["x", "y", "z"]);
  });

  it("starts empty and accumulates", () => {
    const store = makeStore();
    expect(store.getState().inputHistory).toEqual([]);

    for (let i = 0; i < 50; i++) {
      store.getState().pushInputHistory(`cmd-${i}`);
    }
    const hist = store.getState().inputHistory;
    expect(hist).toHaveLength(50);
    expect(hist[0]).toBe("cmd-0");
    expect(hist[49]).toBe("cmd-49");
  });
});

// ── 5. Tool activity tracking ───────────────────────────────

describe("tool activity tracking", () => {
  it("adds a tool activity with running status", () => {
    const store = makeStore();
    const id = store.getState().addToolActivity({ name: "read_file", args: { path: "test.txt" } });

    const activities = store.getState().toolActivities;
    expect(activities).toHaveLength(1);
    expect(activities[0].id).toBe(id);
    expect(activities[0].name).toBe("read_file");
    expect(activities[0].status).toBe("running");
    expect(activities[0].ts).toBeTypeOf("number");
  });

  it("updates running → done with endTs", () => {
    const store = makeStore();
    const id = store.getState().addToolActivity({ name: "write_file", args: {} });

    store.getState().updateToolActivity(id, { status: "done", result: "ok" });

    const activity = store.getState().toolActivities.find((a) => a.id === id);
    expect(activity.status).toBe("done");
    expect(activity.result).toBe("ok");
    expect(activity.endTs).toBeTypeOf("number");
  });

  it("clears all tool activities and resets id counter", () => {
    const store = makeStore();
    store.getState().addToolActivity({ name: "a", args: {} });
    store.getState().addToolActivity({ name: "b", args: {} });
    expect(store.getState().toolActivities).toHaveLength(2);

    store.getState().clearToolActivities();
    expect(store.getState().toolActivities).toHaveLength(0);
    expect(store.getState().nextToolActivityId).toBe(1);
  });

  it("tracks multiple concurrent activities", () => {
    const store = makeStore();
    const id1 = store.getState().addToolActivity({ name: "read_file", args: { path: "a.txt" } });
    const id2 = store.getState().addToolActivity({ name: "shell", args: { cmd: "ls" } });

    expect(store.getState().toolActivities).toHaveLength(2);

    store.getState().updateToolActivity(id1, { status: "done", result: "contents" });

    const acts = store.getState().toolActivities;
    expect(acts.find((a) => a.id === id1).status).toBe("done");
    expect(acts.find((a) => a.id === id2).status).toBe("running");
  });
});

// ── 6. Overlay menu ─────────────────────────────────────────

describe("overlay menu", () => {
  it("opens overlay with type, title, items, and index 0", () => {
    const store = makeStore();
    store.getState().openOverlay("provider", "Select Provider", ["a", "b", "c"]);

    const o = store.getState().overlay;
    expect(o.type).toBe("provider");
    expect(o.title).toBe("Select Provider");
    expect(o.items).toEqual(["a", "b", "c"]);
    expect(o.index).toBe(0);
  });

  it("sets index with overlaySetIndex", () => {
    const store = makeStore();
    store.getState().openOverlay("model", "Models", ["x", "y", "z"]);
    store.getState().overlaySetIndex(2);

    expect(store.getState().overlay.index).toBe(2);
  });

  it("closes overlay", () => {
    const store = makeStore();
    store.getState().openOverlay("provider", "P", ["a"]);
    expect(store.getState().overlay).not.toBeNull();

    store.getState().closeOverlay();
    expect(store.getState().overlay).toBeNull();
  });

  it("overlaySetIndex is no-op when overlay is closed", () => {
    const store = makeStore();
    // No overlay open — should not throw
    store.getState().overlaySetIndex(5);
    expect(store.getState().overlay).toBeNull();
  });
});

// Queue management tests removed — legacy in-memory queue replaced by SQLite bus
// See tests/unit/bus/bus.test.js for bus queue tests
