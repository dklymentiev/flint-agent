import { describe, it, expect, beforeEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

let store;

beforeEach(() => {
  store = createMockStore();
});

describe("process-slice", () => {
  it("addProcess returns incrementing id", () => {
    const id1 = store.getState().addProcess({ cmd: "echo 1", pid: 100 });
    const id2 = store.getState().addProcess({ cmd: "echo 2", pid: 200 });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it("addProcess creates correct structure", () => {
    const id = store.getState().addProcess({ cmd: "npm test", pid: 123 });
    const proc = store.getState().processes.find((p) => p.id === id);
    expect(proc.cmd).toBe("npm test");
    expect(proc.pid).toBe(123);
    expect(proc.status).toBe("running");
    expect(proc.output).toEqual([]);
    expect(proc.exitCode).toBeNull();
  });

  it("appendProcessOutput adds lines", () => {
    const id = store.getState().addProcess({ cmd: "test", pid: 1 });
    store.getState().appendProcessOutput(id, "line1");
    store.getState().appendProcessOutput(id, "line2");
    const proc = store.getState().processes.find((p) => p.id === id);
    expect(proc.output).toEqual(["line1", "line2"]);
  });

  it("appendProcessOutput limits to last 50 lines", () => {
    const id = store.getState().addProcess({ cmd: "test", pid: 1 });
    for (let i = 0; i < 60; i++) {
      store.getState().appendProcessOutput(id, `line${i}`);
    }
    const proc = store.getState().processes.find((p) => p.id === id);
    expect(proc.output).toHaveLength(50);
    expect(proc.output[0]).toBe("line10");
    expect(proc.output[49]).toBe("line59");
  });

  it("finishProcess sets exitCode and status", () => {
    const id = store.getState().addProcess({ cmd: "test", pid: 1 });
    store.getState().finishProcess(id, 0);
    const proc = store.getState().processes.find((p) => p.id === id);
    expect(proc.exitCode).toBe(0);
    expect(proc.status).toBe("done");
  });

  it("finishProcess sets failed for non-zero exit", () => {
    const id = store.getState().addProcess({ cmd: "test", pid: 1 });
    store.getState().finishProcess(id, 1);
    const proc = store.getState().processes.find((p) => p.id === id);
    expect(proc.status).toBe("failed");
  });

  it("finishProcess accepts custom status", () => {
    const id = store.getState().addProcess({ cmd: "test", pid: 1 });
    store.getState().finishProcess(id, null, "killed");
    const proc = store.getState().processes.find((p) => p.id === id);
    expect(proc.status).toBe("killed");
  });

});
