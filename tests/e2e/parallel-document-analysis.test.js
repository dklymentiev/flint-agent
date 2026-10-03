import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handlers, clearDeniedPaths } from "../../src/tools/filesystem.js";
import { createSystemTools } from "../../src/tools/system.js";

// Minimal store mock for system tools
const mockStore = {
  getState: () => ({
    cwd: os.tmpdir(),
    sessionId: "test",
    messages: [],
    _port: 0,
    pendingConfirmation: null,
  }),
  setState: () => {},
  subscribe: () => () => {},
};
const { handlers: sysHandlers } = createSystemTools(mockStore);

function createTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-pardoc-"));
  return { path: dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ── Sample documents for analysis ──

const DOCUMENTS = [
  { name: "report-q1.txt", content: "Q1 2026 Financial Report\nRevenue: $2.4M\nExpenses: $1.8M\nProfit: $600K\nHeadcount: 45\nNew clients: 12\nChurn rate: 3.2%\nKey achievement: Launched product v2.0\nRisk: Supply chain delays" },
  { name: "report-q2.txt", content: "Q2 2026 Financial Report\nRevenue: $3.1M\nExpenses: $2.1M\nProfit: $1.0M\nHeadcount: 52\nNew clients: 18\nChurn rate: 2.8%\nKey achievement: Expanded to EU market\nRisk: Currency fluctuations" },
  { name: "report-q3.txt", content: "Q3 2026 Financial Report\nRevenue: $2.8M\nExpenses: $2.3M\nProfit: $500K\nHeadcount: 58\nNew clients: 9\nChurn rate: 4.1%\nKey achievement: Hired VP Engineering\nRisk: Competitor launched rival product" },
  { name: "report-q4.txt", content: "Q4 2026 Financial Report\nRevenue: $3.5M\nExpenses: $2.5M\nProfit: $1.0M\nHeadcount: 62\nNew clients: 22\nChurn rate: 2.1%\nKey achievement: Series B funding\nRisk: Key employee departures" },
  { name: "meeting-jan.txt", content: "Meeting Notes January 2026\nAttendees: Alice, Bob, Carol\nTopic: Product roadmap\nDecisions: Prioritize mobile app, delay desktop version\nAction items: Alice - wireframes by Feb 1, Bob - backend API spec" },
  { name: "meeting-feb.txt", content: "Meeting Notes February 2026\nAttendees: Alice, Bob, Dave\nTopic: Hiring plan\nDecisions: Hire 3 engineers, 1 designer\nAction items: Dave - post job listings, Alice - review candidates" },
  { name: "meeting-mar.txt", content: "Meeting Notes March 2026\nAttendees: Alice, Carol, Dave\nTopic: Q1 review\nDecisions: Increase marketing budget 20%\nAction items: Carol - budget proposal, Dave - vendor evaluation" },
  { name: "meeting-apr.txt", content: "Meeting Notes April 2026\nAttendees: Bob, Carol, Eve\nTopic: Security audit\nDecisions: Implement 2FA, hire pentester\nAction items: Bob - 2FA integration, Eve - pentest vendor shortlist" },
  { name: "contract-acme.txt", content: "Contract: ACME Corp\nValue: $450,000\nDuration: 12 months\nStart: 2026-01-15\nTerms: NET 30\nDeliverables: API integration, custom dashboard, training\nPenalty: 5% per month late delivery\nStatus: Active" },
  { name: "contract-globex.txt", content: "Contract: Globex Inc\nValue: $280,000\nDuration: 6 months\nStart: 2026-03-01\nTerms: NET 45\nDeliverables: Data migration, reporting module\nPenalty: 10% per month late\nStatus: Active" },
  { name: "contract-initech.txt", content: "Contract: Initech LLC\nValue: $120,000\nDuration: 3 months\nStart: 2026-02-01\nTerms: Prepaid\nDeliverables: Consulting, code review\nPenalty: None\nStatus: Completed" },
  { name: "contract-umbrella.txt", content: "Contract: Umbrella Corp\nValue: $750,000\nDuration: 18 months\nStart: 2026-04-01\nTerms: NET 60\nDeliverables: Full platform build, maintenance\nPenalty: 3% per month late\nStatus: Active" },
  { name: "bug-001.txt", content: "Bug #001: Login page crashes on Safari\nSeverity: Critical\nReported: 2026-01-10\nAssigned: Bob\nStatus: Fixed\nResolution: Polyfill for WebCrypto API" },
  { name: "bug-002.txt", content: "Bug #002: CSV export truncates at 10000 rows\nSeverity: High\nReported: 2026-02-15\nAssigned: Alice\nStatus: Open\nResolution: Pending - need streaming export" },
  { name: "bug-003.txt", content: "Bug #003: Dark mode colors unreadable\nSeverity: Medium\nReported: 2026-03-01\nAssigned: Carol\nStatus: Fixed\nResolution: Updated color palette" },
  { name: "bug-004.txt", content: "Bug #004: Memory leak in real-time dashboard\nSeverity: Critical\nReported: 2026-03-10\nAssigned: Dave\nStatus: Open\nResolution: Pending investigation" },
  { name: "employee-alice.txt", content: "Employee: Alice Chen\nRole: Product Manager\nDepartment: Product\nJoined: 2024-06-01\nSalary: $135,000\nPerformance: Exceeds expectations\nSkills: Roadmapping, Figma, SQL, Agile" },
  { name: "employee-bob.txt", content: "Employee: Bob Smith\nRole: Senior Engineer\nDepartment: Engineering\nJoined: 2023-01-15\nSalary: $155,000\nPerformance: Meets expectations\nSkills: Node.js, React, AWS, Docker" },
  { name: "employee-carol.txt", content: "Employee: Carol Davis\nRole: Designer\nDepartment: Design\nJoined: 2025-03-01\nSalary: $110,000\nPerformance: Exceeds expectations\nSkills: Figma, CSS, User Research, Accessibility" },
  { name: "employee-dave.txt", content: "Employee: Dave Wilson\nRole: DevOps Engineer\nDepartment: Engineering\nJoined: 2025-08-01\nSalary: $145,000\nPerformance: Meets expectations\nSkills: Kubernetes, Terraform, CI/CD, Python" },
];

describe("Parallel document analysis", () => {
  let tmp;

  beforeEach(() => {
    tmp = createTmpDir();
    clearDeniedPaths();
    // Write all 20 documents
    for (const doc of DOCUMENTS) {
      fs.writeFileSync(path.join(tmp.path, doc.name), doc.content, "utf-8");
    }
  });

  afterEach(() => {
    tmp.cleanup();
  });

  // ── Read all 20 documents in parallel ──

  it("reads all 20 documents in parallel", async () => {
    const results = await Promise.all(
      DOCUMENTS.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );
    expect(results).toHaveLength(20);
    results.forEach((r, i) => {
      expect(r).toContain(DOCUMENTS[i].content.split("\n")[0]);
    });
  });

  // ── Extract revenue from all quarterly reports ──

  it("extracts revenue from all quarterly reports in parallel", async () => {
    const reportFiles = DOCUMENTS.filter(d => d.name.startsWith("report-q"));
    const results = await Promise.all(
      reportFiles.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    const revenues = results.map(text => {
      const match = text.match(/Revenue:\s*\$([\d.]+)M/);
      return match ? parseFloat(match[1]) : 0;
    });

    expect(revenues).toEqual([2.4, 3.1, 2.8, 3.5]);
    const total = revenues.reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(11.8, 1);
  });

  // ── Extract profits and find best/worst quarter ──

  it("finds best and worst quarter by profit", async () => {
    const reportFiles = DOCUMENTS.filter(d => d.name.startsWith("report-q"));
    const results = await Promise.all(
      reportFiles.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    const profits = results.map((text, i) => {
      const match = text.match(/Profit:\s*\$([\d.]+)([KM])/);
      const value = match ? parseFloat(match[1]) * (match[2] === "M" ? 1000 : 1) : 0;
      return { quarter: `Q${i + 1}`, profit: value };
    });

    const best = profits.reduce((a, b) => a.profit > b.profit ? a : b);
    const worst = profits.reduce((a, b) => a.profit < b.profit ? a : b);

    expect(["Q2", "Q4"]).toContain(best.quarter); // Q2 and Q4 both $1.0M
    expect(worst.quarter).toBe("Q3"); // Q3 is $500K
  });

  // ── Calculate total contract value ──

  it("calculates total active contract value in parallel", async () => {
    const contractFiles = DOCUMENTS.filter(d => d.name.startsWith("contract-"));
    const results = await Promise.all(
      contractFiles.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    let totalActive = 0;
    const contracts = results.map(text => {
      const value = parseFloat(text.match(/Value:\s*\$([\d,]+)/)?.[1]?.replace(",", "") || "0");
      const status = text.match(/Status:\s*(\w+)/)?.[1] || "";
      if (status === "Active") totalActive += value;
      return { value, status };
    });

    expect(contracts).toHaveLength(4);
    expect(totalActive).toBe(450000 + 280000 + 750000);
  });

  // ── Find all open bugs ──

  it("finds all open critical/high bugs in parallel", async () => {
    const bugFiles = DOCUMENTS.filter(d => d.name.startsWith("bug-"));
    const results = await Promise.all(
      bugFiles.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    const openBugs = results.filter(text =>
      text.includes("Status: Open") &&
      (text.includes("Severity: Critical") || text.includes("Severity: High"))
    );

    expect(openBugs).toHaveLength(2); // bug-002 (High) + bug-004 (Critical)
  });

  // ── Search across all documents with search_in_files ──

  it("searches for keyword across all 20 documents", async () => {
    const result = await handlers.search_in_files({ pattern: "Alice", path: tmp.path });
    expect(result).toContain("meeting-jan.txt");
    expect(result).toContain("meeting-feb.txt");
    expect(result).toContain("employee-alice.txt");
    // Should NOT contain contract files
    expect(result).not.toContain("contract-acme.txt");
  });

  // ── Aggregate employee salaries ──

  it("calculates total salary budget from employee files", async () => {
    const empFiles = DOCUMENTS.filter(d => d.name.startsWith("employee-"));
    const results = await Promise.all(
      empFiles.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    const totalSalary = results.reduce((sum, text) => {
      const match = text.match(/Salary:\s*\$([\d,]+)/);
      return sum + (match ? parseInt(match[1].replace(",", "")) : 0);
    }, 0);

    expect(totalSalary).toBe(135000 + 155000 + 110000 + 145000);
  });

  // ── Find all action items from meetings ──

  it("extracts all action items from meeting notes", async () => {
    const meetingFiles = DOCUMENTS.filter(d => d.name.startsWith("meeting-"));
    const results = await Promise.all(
      meetingFiles.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    const actionItems = results.flatMap(text => {
      const match = text.match(/Action items:\s*(.+)/);
      return match ? match[1].split(",").map(s => s.trim()) : [];
    });

    expect(actionItems.length).toBeGreaterThanOrEqual(8);
    expect(actionItems.some(a => a.includes("Alice"))).toBe(true);
    expect(actionItems.some(a => a.includes("Bob"))).toBe(true);
  });

  // ── Cross-reference: who is assigned to open bugs? ──

  it("cross-references open bugs with employee data", async () => {
    const bugFiles = DOCUMENTS.filter(d => d.name.startsWith("bug-"));
    const empFiles = DOCUMENTS.filter(d => d.name.startsWith("employee-"));

    const [bugResults, empResults] = await Promise.all([
      Promise.all(bugFiles.map(d => handlers.read_file({ path: path.join(tmp.path, d.name) }))),
      Promise.all(empFiles.map(d => handlers.read_file({ path: path.join(tmp.path, d.name) }))),
    ]);

    // Find open bugs assignees
    const openAssignees = bugResults
      .filter(t => t.includes("Status: Open"))
      .map(t => t.match(/Assigned:\s*(\w+)/)?.[1])
      .filter(Boolean);

    expect(openAssignees).toContain("Alice");
    expect(openAssignees).toContain("Dave");

    // Find their departments
    const assigneeDepts = openAssignees.map(name => {
      const emp = empResults.find(e => e.includes(`Employee: ${name}`));
      const dept = emp?.match(/Department:\s*(.+)/)?.[1];
      return { name, department: dept };
    });

    expect(assigneeDepts).toEqual([
      { name: "Alice", department: "Product" },
      { name: "Dave", department: "Engineering" },
    ]);
  });

  // ── Generate summary report to file ──

  it("generates summary report from all documents and saves to file", async () => {
    // Read all in parallel
    const allResults = await Promise.all(
      DOCUMENTS.map(doc => handlers.read_file({ path: path.join(tmp.path, doc.name) }))
    );

    // Analyze
    const revenues = allResults
      .filter(t => t.includes("Revenue:"))
      .map(t => parseFloat(t.match(/Revenue:\s*\$([\d.]+)M/)?.[1] || "0"));
    const totalRevenue = revenues.reduce((s, v) => s + v, 0);

    const contractValues = allResults
      .filter(t => t.includes("Contract:") && t.includes("Status: Active"))
      .map(t => parseInt(t.match(/Value:\s*\$([\d,]+)/)?.[1]?.replace(",", "") || "0"));
    const totalContracts = contractValues.reduce((s, v) => s + v, 0);

    const openBugCount = allResults.filter(t => t.includes("Bug #") && t.includes("Status: Open")).length;
    const criticalBugCount = allResults.filter(t => t.includes("Severity: Critical") && t.includes("Status: Open")).length;
    const employeeCount = allResults.filter(t => t.includes("Employee:")).length;

    const salaries = allResults
      .filter(t => t.includes("Salary:"))
      .map(t => parseInt(t.match(/Salary:\s*\$([\d,]+)/)?.[1]?.replace(",", "") || "0"));
    const totalSalary = salaries.reduce((s, v) => s + v, 0);

    // Write summary
    const summary = [
      "# Annual Summary Report 2026",
      "",
      "## Financial",
      `- Total Revenue: $${totalRevenue.toFixed(1)}M`,
      `- Active Contract Value: $${(totalContracts / 1000).toFixed(0)}K`,
      "",
      "## Team",
      `- Employees: ${employeeCount}`,
      `- Total Salary Budget: $${(totalSalary / 1000).toFixed(0)}K`,
      "",
      "## Issues",
      `- Open Bugs: ${openBugCount}`,
      `- Critical Open: ${criticalBugCount}`,
      "",
      "## Generated automatically from 20 documents",
    ].join("\n");

    const reportPath = path.join(tmp.path, "summary-report.md");
    await handlers.write_file({ path: reportPath, content: summary });

    // Verify
    const saved = fs.readFileSync(reportPath, "utf-8");
    expect(saved).toContain("Total Revenue: $11.8M");
    expect(saved).toContain("Active Contract Value: $1480K");
    expect(saved).toContain("Employees: 4");
    expect(saved).toContain("Total Salary Budget: $545K");
    expect(saved).toContain("Open Bugs: 2");
    expect(saved).toContain("Critical Open: 1");
    expect(saved).toContain("20 documents");
  });
});
