import { describe, it, expect, beforeEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

let store;

beforeEach(() => {
  store = createMockStore();
});

describe("ui-slice", () => {
  it("addLine appends line with incrementing id", () => {
    store.getState().addLine("first");
    store.getState().addLine("second");
    const lines = store.getState().lines;
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("first");
    expect(lines[0].id).toBe(1);
    expect(lines[1].text).toBe("second");
    expect(lines[1].id).toBe(2);
  });

  it("addLine converts empty to space", () => {
    store.getState().addLine("");
    expect(store.getState().lines[0].text).toBe(" ");
  });

  it("setStreamText updates streamText", () => {
    store.getState().setStreamText("streaming...");
    expect(store.getState().streamText).toBe("streaming...");
  });

  it("setActiveTab switches tab", () => {
    store.getState().setActiveTab("toollog");
    expect(store.getState().activeTab).toBe("toollog");
    store.getState().setActiveTab("processes");
    expect(store.getState().activeTab).toBe("processes");
  });

  it("clearScreen adds blank lines and resets tab to chat", () => {
    store.getState().addLine("old line");
    store.getState().setActiveTab("processes");
    store.getState().clearScreen();
    const s = store.getState();
    expect(s.activeTab).toBe("chat");
    // clearScreen resets lines to empty
    expect(s.lines.length).toBe(0);
    expect(s.streamText).toBe("");
  });
});
