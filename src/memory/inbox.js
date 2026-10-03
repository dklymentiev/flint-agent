// Notification inbox — queues reminders, messages, events
// Agent sees count in system prompt, reads with check_inbox tool
// Does NOT interrupt current task focus

let _items = [];  // [{ id, type, content, from, ts }]
let _nextId = 1;

/**
 * Add a notification to the inbox.
 * @param {"reminder"|"message"|"event"} type
 * @param {string} content
 * @param {string} [from] - source (e.g. "schedule", "api", "cron")
 */
export function pushInbox(type, content, from = "") {
  _items.push({
    id: _nextId++,
    type,
    content,
    from,
    ts: new Date().toISOString(),
    read: false,
  });
}

/**
 * Get count of unread notifications.
 */
export function unreadCount() {
  return _items.filter((i) => !i.read).length;
}

/**
 * Get all unread notifications and mark them as read.
 */
export function readInbox() {
  const unread = _items.filter((i) => !i.read);
  for (const item of unread) {
    item.read = true;
  }
  return unread;
}

/**
 * Get all items (read + unread), last N.
 */
export function allInbox(limit = 50) {
  return _items.slice(-limit);
}

/**
 * Format inbox summary for system prompt injection.
 * Returns null if no unread notifications.
 */
export function inboxPromptHint() {
  const count = unreadCount();
  if (count === 0) return null;
  const types = {};
  for (const item of _items.filter((i) => !i.read)) {
    types[item.type] = (types[item.type] || 0) + 1;
  }
  const parts = Object.entries(types).map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`);
  return `You have ${count} unread notification${count > 1 ? "s" : ""} (${parts.join(", ")}). Use check_inbox tool to read them when you have a moment. Do NOT interrupt your current task.`;
}
