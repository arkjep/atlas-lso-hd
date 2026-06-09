interface AtlasTask {
  id: string;
  title: string;
  description: string;
  urls: string[];
  status: string;
}

interface AtlasUser {
  id: string;
  email: string;
  name: string;
}

interface TaskSourceResolvedRef {
  provider: string;
  externalObjectType?: string;
  externalObjectId: string;
  externalUrl?: string;
  externalTitle?: string;
  externalStatus?: string;
  metadata?: unknown;
}

interface TaskSourceThreadMessage {
  id?: string;
  sender?: string;
  text: string;
  html?: string;
  date?: string;
  link?: string;
  outgoing?: boolean;
}

interface TaskSourceThread {
  title?: string;
  messages: TaskSourceThreadMessage[];
  raw?: unknown;
}

interface TaskSourceProvider {
  id: string;
  name?: string;
  resolveUrl: (input: { url: string; task?: AtlasTask | null; user?: AtlasUser }) => Promise<TaskSourceResolvedRef | null>;
  fetchThread: (input: { ref: TaskSourceResolvedRef; task: AtlasTask; user: AtlasUser }) => Promise<TaskSourceThread | null>;
  postCompletionReply: (input: { ref: TaskSourceResolvedRef; task: AtlasTask; user: AtlasUser; message: string }) => Promise<unknown>;
  markComplete: (input: { ref: TaskSourceResolvedRef; task: AtlasTask; user: AtlasUser; draft?: string; replyPosted: boolean }) => Promise<unknown>;
}

const providerId = "lso-helpdesk";

function env(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function requiredEnv(name: string) {
  const value = env(name);

  if (!value) {
    throw new Error(`${name} is required for ${providerId}`);
  }

  return value;
}

function ticketUrlPattern() {
  return new RegExp(env("LSO_HD_URL_PATTERN", "/tickets?/([^/?#]+)"), "i");
}

function ticketIdFromUrl(url: string) {
  const match = ticketUrlPattern().exec(url);
  const rawTicketId = match?.[1];

  return rawTicketId ? decodeURIComponent(rawTicketId) : null;
}

function pathFor(template: string, ticketId: string) {
  return template.replace(/:id\b/g, encodeURIComponent(ticketId));
}

function endpoint(pathTemplate: string, ticketId: string) {
  const baseUrl = requiredEnv("LSO_HD_BASE_URL").replace(/\/+$/, "");
  const path = pathFor(pathTemplate, ticketId);

  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function helpdeskRequest(pathTemplate: string, ticketId: string, init: RequestInit = {}) {
  const response = await fetch(endpoint(pathTemplate, ticketId), {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${requiredEnv("LSO_HD_API_TOKEN")}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : null;

  if (!response.ok) {
    throw new Error(`LSO helpdesk returned ${response.status}: ${text || response.statusText}`);
  }

  return payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedRecord(value: unknown, key: string) {
  return asRecord(asRecord(value)[key]);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function ticketRecord(payload: unknown) {
  const record = asRecord(payload);
  return asRecord(record.ticket ?? record.data ?? payload);
}

function ticketTitle(ticket: Record<string, unknown>) {
  return stringValue(ticket.subject)
    ?? stringValue(ticket.title)
    ?? stringValue(ticket.summary)
    ?? stringValue(ticket.name);
}

function ticketStatus(ticket: Record<string, unknown>) {
  return stringValue(ticket.status)
    ?? stringValue(nestedRecord(ticket, "state").name);
}

function ticketMessages(ticketPayload: unknown, messagesPayload: unknown) {
  const ticket = ticketRecord(ticketPayload);
  const messagesRecord = asRecord(messagesPayload);
  const messages = arrayValue(messagesRecord.messages)
    .concat(arrayValue(messagesRecord.data))
    .concat(arrayValue(ticket.messages))
    .concat(arrayValue(ticket.thread))
    .concat(arrayValue(ticket.conversation));

  return messages.map((message, index): TaskSourceThreadMessage | null => {
    const record = asRecord(message);
    const sender = stringValue(record.sender)
      ?? stringValue(record.from)
      ?? stringValue(nestedRecord(record, "author").name)
      ?? stringValue(nestedRecord(record, "user").name)
      ?? stringValue(nestedRecord(record, "createdBy").name);
    const text = stringValue(record.text)
      ?? stringValue(record.body)
      ?? stringValue(record.plainText)
      ?? stringValue(record.message)
      ?? stringValue(record.content);
    const html = stringValue(record.html)
      ?? stringValue(record.htmlBody);

    if (!text && !html) {
      return null;
    }

    return {
      id: stringValue(record.id) ?? String(index + 1),
      sender,
      text: text ?? html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "",
      html,
      date: stringValue(record.date) ?? stringValue(record.createdAt) ?? stringValue(record.created_at),
      link: stringValue(record.url) ?? stringValue(record.link),
      outgoing: Boolean(record.outgoing ?? record.isStaffReply ?? record.internal === false && sender?.includes(env("LSO_HD_AGENT_EMAIL", "\u0000")))
    };
  }).filter((message): message is TaskSourceThreadMessage => Boolean(message));
}

async function fetchTicket(ticketId: string) {
  return helpdeskRequest(env("LSO_HD_TICKET_PATH", "/tickets/:id"), ticketId);
}

async function fetchMessages(ticketId: string) {
  const path = env("LSO_HD_MESSAGES_PATH", "/tickets/:id/messages");

  try {
    return await helpdeskRequest(path, ticketId);
  } catch (error) {
    if (path === env("LSO_HD_TICKET_PATH", "/tickets/:id")) {
      throw error;
    }

    return null;
  }
}

const provider: TaskSourceProvider = {
  id: providerId,
  name: "LSO Helpdesk",

  async resolveUrl({ url }) {
    const ticketId = ticketIdFromUrl(url);

    if (!ticketId) {
      return null;
    }

    const payload = await fetchTicket(ticketId);
    const ticket = ticketRecord(payload);

    return {
      provider: providerId,
      externalObjectType: "ticket",
      externalObjectId: ticketId,
      externalUrl: url,
      externalTitle: ticketTitle(ticket),
      externalStatus: ticketStatus(ticket),
      metadata: {
        resolvedAt: new Date().toISOString(),
        ticket
      }
    };
  },

  async fetchThread({ ref }) {
    const ticketPayload = await fetchTicket(ref.externalObjectId);
    const messagesPayload = await fetchMessages(ref.externalObjectId);
    const ticket = ticketRecord(ticketPayload);
    const messages = ticketMessages(ticketPayload, messagesPayload);

    return {
      title: ticketTitle(ticket) ?? ref.externalTitle,
      messages,
      raw: {
        ticket: ticketPayload,
        messages: messagesPayload
      }
    };
  },

  async postCompletionReply({ ref, message }) {
    return helpdeskRequest(env("LSO_HD_REPLY_PATH", "/tickets/:id/replies"), ref.externalObjectId, {
      method: env("LSO_HD_REPLY_METHOD", "POST"),
      body: JSON.stringify({ body: message })
    });
  },

  async markComplete({ ref }) {
    const body = env("LSO_HD_COMPLETE_BODY", "{\"status\":\"completed\"}");

    return helpdeskRequest(env("LSO_HD_COMPLETE_PATH", "/tickets/:id"), ref.externalObjectId, {
      method: env("LSO_HD_COMPLETE_METHOD", "PATCH"),
      body
    });
  }
};

export default provider;
export { provider };
