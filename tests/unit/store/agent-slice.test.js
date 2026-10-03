import { describe, it, expect, beforeEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

let store;

beforeEach(() => {
  store = createMockStore();
});

describe("agent-slice", () => {
  it("setAgentStatus changes status and currentTool", () => {
    store.getState().setAgentStatus("calling-tool", "read_file");
    const s = store.getState();
    expect(s.agentStatus).toBe("calling-tool");
    expect(s.currentTool).toBe("read_file");
  });

  it("setAgentStatus clears tool when not provided", () => {
    store.getState().setAgentStatus("calling-tool", "read_file");
    store.getState().setAgentStatus("idle");
    expect(store.getState().currentTool).toBeNull();
  });

  it("incrementQueue / decrementQueue", () => {
    store.getState().incrementQueue();
    store.getState().incrementQueue();
    expect(store.getState().processingCount).toBe(2);
    store.getState().decrementQueue();
    expect(store.getState().processingCount).toBe(1);
  });

  it("decrementQueue does not go below 0", () => {
    store.getState().decrementQueue();
    expect(store.getState().processingCount).toBe(0);
  });

  it("setPendingAction / clearPendingAction", () => {
    store.getState().setPendingAction("restart");
    expect(store.getState().pendingAction).toBe("restart");
    store.getState().clearPendingAction();
    expect(store.getState().pendingAction).toBeNull();
  });

  it("addToolActivity adds entry and returns id", () => {
    const id = store.getState().addToolActivity({ name: "read_file", args: { path: "a.txt" } });
    expect(id).toBe(1);
    const activities = store.getState().toolActivities;
    expect(activities).toHaveLength(1);
    expect(activities[0].name).toBe("read_file");
    expect(activities[0].status).toBe("running");
  });

  it("toolActivities rotates at max 30", () => {
    for (let i = 0; i < 35; i++) {
      store.getState().addToolActivity({ name: `tool${i}`, args: {} });
    }
    expect(store.getState().toolActivities).toHaveLength(30);
    // First entries should have been dropped
    expect(store.getState().toolActivities[0].name).toBe("tool5");
  });

  it("updateToolActivity updates specific entry", () => {
    const id = store.getState().addToolActivity({ name: "test", args: {} });
    store.getState().updateToolActivity(id, { result: "done", status: "done" });
    const activity = store.getState().toolActivities.find((a) => a.id === id);
    expect(activity.result).toBe("done");
    expect(activity.status).toBe("done");
  });

  it("clearToolActivities resets", () => {
    store.getState().addToolActivity({ name: "test", args: {} });
    store.getState().clearToolActivities();
    expect(store.getState().toolActivities).toHaveLength(0);
    expect(store.getState().nextToolActivityId).toBe(1);
  });

  it("pendingConfirmation is null by default", () => {
    expect(store.getState().pendingConfirmation).toBeNull();
  });

  it("setPendingConfirmation / clearPendingConfirmation", () => {
    const conf = { id: 1, toolName: "write_file", args: {}, resolve: () => {} };
    store.getState().setPendingConfirmation(conf);
    expect(store.getState().pendingConfirmation).toBe(conf);

    store.getState().clearPendingConfirmation();
    expect(store.getState().pendingConfirmation).toBeNull();
  });
});
