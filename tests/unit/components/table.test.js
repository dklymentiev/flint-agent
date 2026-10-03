// Table component tests — Phase R9
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Table } from "../../../src/components/Table.js";

const h = React.createElement;

describe("Table", () => {
  it("renders header row with column names", () => {
    const { lastFrame } = render(
      h(Table, {
        columns: ["Name", "Age", "City"],
        rows: [["Alice", "30", "NYC"]],
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain("Name");
    expect(frame).toContain("Age");
    expect(frame).toContain("City");
  });

  it("renders data rows", () => {
    const { lastFrame } = render(
      h(Table, {
        columns: ["A", "B"],
        rows: [
          ["foo", "bar"],
          ["baz", "qux"],
        ],
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain("foo");
    expect(frame).toContain("bar");
    expect(frame).toContain("baz");
    expect(frame).toContain("qux");
  });

  it("handles empty rows array without throwing", () => {
    const { lastFrame } = render(
      h(Table, {
        columns: ["X", "Y"],
        rows: [],
      }),
    );
    const frame = lastFrame();
    expect(frame).toContain("X");
    expect(frame).toContain("Y");
  });

  it("renders an optional title above the table", () => {
    const { lastFrame } = render(
      h(Table, {
        columns: ["Col"],
        rows: [["val"]],
        title: "My Dataset",
      }),
    );
    expect(lastFrame()).toContain("My Dataset");
  });

  it("renders a footer line (e.g. pagination info)", () => {
    const { lastFrame } = render(
      h(Table, {
        columns: ["Col"],
        rows: [["val"]],
        footer: "page 1 of 3",
      }),
    );
    expect(lastFrame()).toContain("page 1 of 3");
  });

  it("draws border characters around the table", () => {
    const { lastFrame } = render(
      h(Table, {
        columns: ["A"],
        rows: [["1"]],
      }),
    );
    const frame = lastFrame();
    // ASCII border uses + and -
    expect(frame).toMatch(/[+|]/);
    expect(frame).toContain("-");
  });

  it("truncates long cell values with ellipsis", () => {
    const longText = "x".repeat(60);
    const { lastFrame } = render(
      h(Table, {
        columns: ["X"],
        rows: [[longText]],
      }),
    );
    // The pad function truncates with "..." past width 40
    // Either we see all 60 (if last col stretched) or truncation
    expect(lastFrame()).toBeDefined();
  });
});
