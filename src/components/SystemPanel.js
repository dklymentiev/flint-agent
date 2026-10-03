// SystemPanel — system info tab (model, session, context, config, MCP, plugins, datasets)
import React from "react";
import { Box, Text } from "ink";
import { getDefinitions, getMcpStatus, getLoadedPlugins } from "../tools/registry.js";

const { createElement: h, useSyncExternalStore, useRef } = React;

function useStoreSelector(store, selector) {
  const prev = useRef(null);
  return useSyncExternalStore(store.subscribe, () => {
    const next = selector(store.getState());
    if (prev.current !== null && shallowEqual(prev.current, next)) {
      return prev.current;
    }
    prev.current = next;
    return next;
  });
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function SystemPanel({ store }) {
  const info = useStoreSelector(store, (s) => ({
    model: s.model,
    pricing: s.pricing,
    contextLimit: s.contextLimit,
    lastContextTokens: s.lastContextTokens,
    sessionId: s.sessionId,
    messageCount: s.userMessageCount || 0,
    sessionCost: s.sessionCost,
    sessionPromptTokens: s.sessionPromptTokens,
    sessionCompletionTokens: s.sessionCompletionTokens,
    port: s._port || 3000,
    version: s._version || "?",
    profile: s._profile || null,
    agentStatus: s.agentStatus,
    datasetCount: Object.keys(s.datasets || {}).length,
  }));

  const section = (title, rows) =>
    h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { bold: true, color: "cyan" }, ` ${title}`),
      ...rows.map((r, i) => h(Text, { key: i, dimColor: !r.highlight }, `   ${r.label}: ${r.value}`)),
    );

  const sections = [];

  // Model
  const modelRows = [];
  if (info.model) modelRows.push({ label: "Name", value: info.model });
  if (info.pricing) {
    modelRows.push({
      label: "Pricing",
      value: `$${(info.pricing.prompt * 1e6).toFixed(2)} / $${(info.pricing.completion * 1e6).toFixed(2)} per 1M tok`,
    });
  }
  if (modelRows.length) sections.push(section("Model", modelRows));

  // Session
  const sessRows = [];
  if (info.sessionId) sessRows.push({ label: "ID", value: info.sessionId });
  sessRows.push({ label: "Messages", value: String(info.messageCount) });
  sessRows.push({ label: "Cost", value: `$${info.sessionCost.toFixed(4)}`, highlight: info.sessionCost > 0 });
  sessRows.push({ label: "Tokens", value: `${info.sessionPromptTokens + info.sessionCompletionTokens}` });
  sections.push(section("Session", sessRows));

  // Context
  if (info.contextLimit) {
    const pct = info.lastContextTokens
      ? ((info.lastContextTokens / info.contextLimit) * 100).toFixed(1)
      : "0.0";
    const cur = info.lastContextTokens >= 1000
      ? (info.lastContextTokens / 1000).toFixed(1) + "k"
      : String(info.lastContextTokens || 0);
    const lim = info.contextLimit >= 1e6
      ? (info.contextLimit / 1e6).toFixed(0) + "M"
      : (info.contextLimit / 1000).toFixed(0) + "k";
    sections.push(section("Context", [
      { label: "Used", value: `${cur} / ${lim}  (${pct}%)`, highlight: parseFloat(pct) > 80 },
    ]));
  }

  // Runtime
  const mem = process.memoryUsage();
  const rssMB = (mem.rss / 1024 / 1024).toFixed(0);
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
  const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(0);
  const uptimeSec = Math.floor(process.uptime());
  const uptimeStr = uptimeSec < 60 ? `${uptimeSec}s`
    : uptimeSec < 3600 ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  sections.push(section("Runtime", [
    { label: "Memory", value: `${rssMB} MB RSS  (heap: ${heapMB}/${heapTotalMB} MB)`, highlight: parseInt(rssMB) > 500 },
    { label: "Uptime", value: uptimeStr },
    { label: "PID", value: String(process.pid) },
    { label: "Node", value: process.version },
  ]));

  // Config
  const configRows = [
    { label: "Version", value: `v${info.version}` },
    { label: "API port", value: String(info.port) },
  ];
  if (info.profile) configRows.push({ label: "Profile", value: info.profile });
  configRows.push({ label: "Tools", value: String(getDefinitions().length) });
  configRows.push({ label: "Security", value: process.env.AGENT_SECURITY_DISABLE === "1" ? "disabled" : (process.env.AGENT_SECURITY_POLICY || "normal") });
  sections.push(section("Config", configRows));

  // Agent
  sections.push(section("Agent", [
    { label: "Status", value: info.agentStatus, highlight: info.agentStatus !== "idle" },
  ]));

  // MCP Servers
  const mcpServers = getMcpStatus();
  if (mcpServers.length) {
    const mcpRows = mcpServers.map((s) => ({
      label: s.name,
      value: s.ok ? `${s.tools} tools` : `error: ${s.error}`,
      highlight: !s.ok,
    }));
    sections.push(section("MCP Servers", mcpRows));
  }

  // Plugins
  const plugins = getLoadedPlugins();
  if (plugins.length) {
    const pluginRows = plugins.map((p) => ({
      label: p.name,
      value: `${p.description || p.type} (${p.toolCount} tools)`,
    }));
    sections.push(section("Plugins", pluginRows));
  }

  // Datasets
  if (info.datasetCount > 0) {
    const datasets = store.getState().datasets;
    const dsRows = Object.values(datasets).map((ds) => ({
      label: ds.label,
      value: `${ds.rows.length} rows (${ds.source})`,
    }));
    sections.push(section("Datasets", dsRows));
  }

  return h(Box, { flexDirection: "column" }, ...sections);
}
