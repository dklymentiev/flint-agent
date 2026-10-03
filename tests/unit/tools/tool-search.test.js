// tool_search: find tools by describing the job.

import { describe, it, expect, beforeEach } from "vitest";
import { rankTools, createToolSearchHandler, loadedToolNames, resetLoadedTools, CORE_TOOLS } from "../../../src/tools/tool-search.js";

const def = (name, description) => ({ type: "function", function: { name, description } });

const REGISTRY = [
  def("read_file", "Read a file"),
  def("mcp_screenbox_desktop_click", "Click at coordinates on a virtual desktop"),
  def("mcp_screenbox_desktop_screenshot", "Take a screenshot of a virtual desktop"),
  def("mcp_browser_navigate", "Open a URL in the browser tab"),
  def("mcp_browser_fill", "Fill an input field on the current page"),
  def("mcp_mail_mail_send", "Send an email from a mailbox"),
  def("mcp_planner_planner_task", "Read one planner task"),
];

beforeEach(() => resetLoadedTools());

describe("rankTools", () => {
  it("finds a tool by what the job is, not by its exact name", () => {
    const names = rankTools("take a screenshot of the remote desktop", REGISTRY).map((t) => t.function.name);
    expect(names[0]).toBe("mcp_screenbox_desktop_screenshot");
  });

  it("matches word forms and split names", () => {
    const names = rankTools("clicking on the desktop", REGISTRY).map((t) => t.function.name);
    expect(names[0]).toBe("mcp_screenbox_desktop_click");
  });

  it("returns nothing for a query with no matching words", () => {
    expect(rankTools("zzzz qqqq", REGISTRY)).toEqual([]);
  });
});

describe("the tool_search handler", () => {
  it("loads what it finds and keeps it for the session", () => {
    const search = createToolSearchHandler(() => REGISTRY);
    const out = search({ query: "send an email" });
    expect(out).toContain("mcp_mail_mail_send");
    expect(loadedToolNames()).toContain("mcp_mail_mail_send");
  });

  it("does not offer what the core set already has", () => {
    const search = createToolSearchHandler(() => REGISTRY);
    const out = search({ query: "read a file" });
    expect(CORE_TOOLS).toContain("read_file");
    expect(out).not.toContain("- read_file:");
  });

  it("says so when nothing matches, instead of returning an empty list", () => {
    const search = createToolSearchHandler(() => REGISTRY);
    expect(search({ query: "zzzz" })).toMatch(/^No tools matched/);
  });
});
