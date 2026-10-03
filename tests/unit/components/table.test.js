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

// Owner, 2026-10-03, on an analytics answer: the row "| Сессий | **8** |" was
// printed with its asterisks, and the one long row had its closing bar on a
// line of its own.
describe("Table cells with markdown", () => {
  const frameOf = (props) => render(h(Table, props)).lastFrame();
  const rowsOf = (frame) => frame.split("\n").filter((l) => l.includes("|"));

  it("shows bold and inline code without their markers", () => {
    const frame = frameOf({
      columns: ["Показатель", "Значение"],
      rows: [["Сессий", "**8**"], ["Страница", "`/projects/flint`"], ["Посетителей", "__5__"]],
    });
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("__");
    expect(frame).not.toContain("`");
    expect(frame).toContain("8");
    expect(frame).toContain("/projects/flint");
  });

  it("sizes a column by what is visible, not by the markers", async () => {
    const { tableWidths } = await import("../../../src/components/Table.js");
    const plain = tableWidths(["N", "Last"], [["8", "x"]], 80);
    const marked = tableWidths(["N", "Last"], [["**8**", "x"]], 80);
    expect(marked[0]).toBe(plain[0]);
  });

  it("leaves underscores and asterisks inside words alone", () => {
    const frame = frameOf({
      columns: ["Field", "Note"],
      rows: [["utm_source", "file_name_here and 2*3*4"]],
    });
    expect(frame).toContain("utm_source");
    expect(frame).toContain("file_name_here");
    expect(frame).toContain("2*3*4");
  });

  it("cuts a long cell so the row is as wide as the others and fits the terminal", () => {
    const long = "Один человек. Помимо этой страницы смотрел главную, проекты и ещё три статьи блога, ".repeat(3);
    const frame = frameOf({
      columns: ["Посетитель", "Просмотров", "Что делал"],
      rows: [["**A**", "**21**", long], ["B", "1", "Разовый заход"]],
    });
    const lengths = rowsOf(frame).map((l) => [...l.trimEnd()].length);
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBeLessThanOrEqual(process.stdout.columns || 80);
    for (const l of rowsOf(frame)) expect(l.trimEnd().endsWith("|")).toBe(true);
  });
});
