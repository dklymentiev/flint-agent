// Inbox tools — check_inbox, dismiss_notifications
import { readInbox, allInbox, unreadCount } from "../memory/inbox.js";

export function createInboxTools() {
  return [
    {
      type: "function",
      function: {
        name: "check_inbox",
        description: "Read unread notifications (reminders, messages, events). Returns all unread items and marks them as read.",
        parameters: {
          type: "object",
          properties: {
            all: {
              type: "boolean",
              description: "If true, show all recent notifications (including already read). Default: false (unread only).",
            },
          },
        },
      },
    },
  ];
}

export async function handleInboxTool(name, args) {
  if (name === "check_inbox") {
    const showAll = args?.all || false;
    const items = showAll ? allInbox(30) : readInbox();

    if (items.length === 0) {
      return showAll ? "No recent notifications." : "No unread notifications.";
    }

    const lines = items.map((item) => {
      const status = item.read ? "(read)" : "(new)";
      const time = item.ts.slice(11, 16); // HH:MM
      const from = item.from ? ` from ${item.from}` : "";
      return `[${time}] ${item.type}${from} ${status}: ${item.content}`;
    });

    const remaining = unreadCount();
    const footer = remaining > 0 ? `\n${remaining} more unread.` : "";

    return lines.join("\n") + footer;
  }

  return null;
}
