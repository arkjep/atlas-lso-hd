import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  automation?: {
    markCompleteOnTaskComplete?: boolean;
    postCompletionReplyOnTaskComplete?: boolean;
  };
  resolveUrl: (input: { url: string; task?: AtlasTask | null; user?: AtlasUser }) => Promise<TaskSourceResolvedRef | null>;
  fetchThread: (input: { ref: TaskSourceResolvedRef; task: AtlasTask; user: AtlasUser }) => Promise<TaskSourceThread | null>;
  postCompletionReply: (input: { ref: TaskSourceResolvedRef; task: AtlasTask; user: AtlasUser; message: string }) => Promise<unknown>;
  markComplete: (input: { ref: TaskSourceResolvedRef; task: AtlasTask; user: AtlasUser; draft?: string; replyPosted: boolean }) => Promise<unknown>;
}

const providerId = "lso-helpdesk";
const defaultTrpcBaseUrl = "https://hd-api.lowstresstrading.com/trpc";
const defaultWorkspaceId = "LST";
const completeStatus = "closed";
const conversationUrlPattern = /^https?:\/\/hd\.lowstresstrading\.com\/([^/]+)\/dashboard\/conversation\/([^/?#]+)/i;
let cachedAccessToken: string | null = null;

function loadLocalEnv() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(moduleDir, "..", ".env");

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");

    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    process.env[key] ??= value;
  }
}

loadLocalEnv();

function env(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function configuredToken() {
  return env("LSO_HD_ACCESS_TOKEN") || env("LSO_HD_API_TOKEN");
}

function passcode() {
  return env("LSO_HD_PASSCODE") || env("LSO_HD_PASSWORD");
}

function hasLoginCredentials() {
  return Boolean(env("LSO_HD_PHONE") && passcode());
}

async function accessToken(forceLogin = false) {
  const value = configuredToken();

  if (value && !forceLogin) {
    return value;
  }

  if (cachedAccessToken && !forceLogin) {
    return cachedAccessToken;
  }

  const phone = env("LSO_HD_PHONE");
  const password = passcode();

  if (!phone || !password) {
    throw new Error("Set LSO_HD_ACCESS_TOKEN, or set LSO_HD_PHONE and LSO_HD_PASSCODE for lso-helpdesk login.");
  }

  cachedAccessToken = await login(phone, password);
  return cachedAccessToken;
}

function trpcBaseUrl() {
  return env("LSO_HD_TRPC_URL", env("LSO_HD_BASE_URL", defaultTrpcBaseUrl)).replace(/\/+$/, "");
}

function workspaceIdFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const workspace = parsed.pathname.split("/").filter(Boolean)[0];
    return workspace ? workspace.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

function conversationIdFromUrl(url: string) {
  const match = conversationUrlPattern.exec(url);
  const conversationId = match?.[2] ?? match?.[1];

  return conversationId ? decodeURIComponent(conversationId) : null;
}

function workspaceId(input?: { url?: string; ref?: TaskSourceResolvedRef }) {
  const metadata = asRecord(input?.ref?.metadata);
  return stringValue(metadata.workspaceId)
    ?? (input?.url ? workspaceIdFromUrl(input.url) : undefined)
    ?? defaultWorkspaceId;
}

async function trpcHeaders(authenticated: boolean, forceLogin = false) {
  return {
    accept: "application/json",
    ...(authenticated ? { authorization: `Bearer ${await accessToken(forceLogin)}` } : {})
  };
}

function trpcInput(input: unknown) {
  return env("LSO_HD_TRPC_INPUT_FORMAT", "raw") === "json" ? { json: input } : input;
}

async function trpcRequest(path: string, init: RequestInit, url = `${trpcBaseUrl()}/${path}`, options?: { authenticated?: boolean; forceLogin?: boolean; retriedAuth?: boolean }) {
  const authenticated = options?.authenticated ?? true;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...await trpcHeaders(authenticated, options?.forceLogin),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : null;

  if (response.status === 401 && authenticated && !options?.retriedAuth && hasLoginCredentials()) {
    cachedAccessToken = null;

    return trpcRequest(path, init, url, {
      ...options,
      forceLogin: true,
      retriedAuth: true
    });
  }

  if (!response.ok) {
    throw new Error(`LSO helpdesk ${path} returned ${response.status}: ${text || response.statusText}`);
  }

  return unwrapTrpcResponse(payload);
}

async function trpcQuery<T>(path: string, input: unknown, options?: { authenticated?: boolean }): Promise<T> {
  const url = new URL(`${trpcBaseUrl()}/${path}`);
  url.searchParams.set("input", JSON.stringify(trpcInput(input)));

  return trpcRequest(path, {
    method: "GET",
    signal: AbortSignal.timeout(Number(env("LSO_HD_TIMEOUT_MS", "30000")))
  }, url.href, options) as Promise<T>;
}

async function trpcMutate<T>(path: string, input: unknown, options?: { authenticated?: boolean }): Promise<T> {
  return trpcRequest(path, {
    method: "POST",
    body: JSON.stringify(trpcInput(input)),
    signal: AbortSignal.timeout(Number(env("LSO_HD_TIMEOUT_MS", "30000")))
  }, undefined, options) as Promise<T>;
}

function unwrapTrpcResponse(payload: unknown) {
  const record = asRecord(payload);
  const result = asRecord(record.result);
  const data = asRecord(result.data);

  if ("json" in data) {
    return data.json;
  }

  if ("data" in result) {
    return result.data;
  }

  return payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

async function login(phone: string, password: string) {
  const check = await trpcQuery<Record<string, unknown>>("auth.checkPhone", { phone }, { authenticated: false });
  const exists = Boolean(check.exists);
  const payload = exists
    ? await trpcMutate<Record<string, unknown>>("auth.login", { phone, password }, { authenticated: false })
    : await trpcQuery<Record<string, unknown>>("users.doLogin", { phone, password }, { authenticated: false });
  const user = asRecord(payload.user);
  const token = stringValue(user.accessToken);

  if (!token) {
    throw new Error("LSO helpdesk login did not return user.accessToken.");
  }

  return token;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function idString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }

  return undefined;
}

interface ConversationPayload {
  conversation?: unknown;
  contact?: unknown;
  messages?: unknown;
}

async function getConversation(conversationId: string, workspaceId: string) {
  return trpcQuery<ConversationPayload>("conversations.getConversation", {
    conversationId,
    workspaceId
  });
}

async function getCurrentUser() {
  const fallbackUid = env("LSO_HD_AGENT_UID");
  const fallbackName = env("LSO_HD_AGENT_NAME", "ATLAS");

  if (fallbackUid) {
    return {
      uid: fallbackUid,
      name: fallbackName
    };
  }

  const token = await accessToken();
  const user = await trpcQuery<Record<string, unknown>>("users.getUser", {
    socialLairToken: token
  });

  return {
    uid: stringValue(user.uid) ?? stringValue(user._id) ?? stringValue(user.id) ?? fallbackUid ?? "",
    name: stringValue(user.name) ?? stringValue(user.email) ?? fallbackName
  };
}

function conversationTitle(conversation: Record<string, unknown>) {
  return stringValue(conversation.title)
    ?? stringValue(conversation.subject)
    ?? stringValue(conversation._id);
}

function conversationStatus(conversation: Record<string, unknown>) {
  return stringValue(conversation.status);
}

function contactEmails(contact: Record<string, unknown>) {
  return arrayValue(contact.emails).filter((email): email is string => typeof email === "string" && email.includes("@"));
}

function messageSender(message: Record<string, unknown>, contact: Record<string, unknown>) {
  return stringValue(message.sentByUserName)
    ?? stringValue(message.sender)
    ?? stringValue(message.from)
    ?? stringValue(contact.name)
    ?? contactEmails(contact)[0];
}

function messageHtml(message: Record<string, unknown>) {
  return stringValue(message.html)
    ?? stringValue(message.bodyHtml)
    ?? stringValue(asRecord(message.rawWebhookData)["body-html"]);
}

function messageText(message: Record<string, unknown>) {
  return stringValue(message.text)
    ?? stringValue(message.body)
    ?? stringValue(asRecord(message.rawWebhookData)["body-plain"])
    ?? (messageHtml(message) ? stripHtml(messageHtml(message) ?? "") : undefined);
}

function conversationMessages(payload: ConversationPayload) {
  const contact = asRecord(payload.contact);
  const includeInternalNotes = env("LSO_HD_INCLUDE_INTERNAL_NOTES", "false").toLowerCase() === "true";

  return arrayValue(payload.messages).map((message, index): TaskSourceThreadMessage | null => {
    const record = asRecord(message);
    const type = stringValue(record.type);

    if (type === "NOTE" && !includeInternalNotes) {
      return null;
    }

    const text = messageText(record);
    const html = messageHtml(record);

    if (!text && !html) {
      return null;
    }

    return {
      id: idString(record._id) ?? idString(record.id) ?? String(index + 1),
      sender: messageSender(record, contact),
      text: text ?? "",
      html,
      date: stringValue(record.createdAt) ?? stringValue(record.created_at) ?? stringValue(record.date),
      outgoing: Boolean(record.sentByUserId || record.outgoing)
    };
  }).filter((message): message is TaskSourceThreadMessage => Boolean(message));
}

function replyHtml(message: string) {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<p>${escaped.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>`;
}

const provider: TaskSourceProvider = {
  id: providerId,
  name: "LSO Helpdesk",
  automation: {
    markCompleteOnTaskComplete: true,
    postCompletionReplyOnTaskComplete: false
  },

  async resolveUrl({ url }) {
    const conversationId = conversationIdFromUrl(url);

    if (!conversationId) {
      return null;
    }

    const workspaceIdValue = workspaceId({ url });
    const payload = await getConversation(conversationId, workspaceIdValue);
    const conversation = asRecord(payload.conversation);
    const contact = asRecord(payload.contact);

    return {
      provider: providerId,
      externalObjectType: "conversation",
      externalObjectId: conversationId,
      externalUrl: url,
      externalTitle: conversationTitle(conversation),
      externalStatus: conversationStatus(conversation),
      metadata: {
        workspaceId: workspaceIdValue,
        resolvedAt: new Date().toISOString(),
        conversation,
        contact
      }
    };
  },

  async fetchThread({ ref }) {
    const workspaceIdValue = workspaceId({ ref });
    const payload = await getConversation(ref.externalObjectId, workspaceIdValue);
    const conversation = asRecord(payload.conversation);

    return {
      title: conversationTitle(conversation) ?? ref.externalTitle,
      messages: conversationMessages(payload),
      raw: payload
    };
  },

  async postCompletionReply({ ref, message }) {
    const workspaceIdValue = workspaceId({ ref });
    const payload = await getConversation(ref.externalObjectId, workspaceIdValue);
    const contact = asRecord(payload.contact);
    const currentUser = await getCurrentUser();
    const email = env("LSO_HD_REPLY_TO_EMAIL") || contactEmails(contact)[0];

    if (!email) {
      throw new Error("No contact email is available for this conversation.");
    }

    if (!currentUser.uid) {
      throw new Error("No LSO helpdesk user UID is available. Set LSO_HD_AGENT_UID.");
    }

    const input: Record<string, unknown> = {
      workspaceId: workspaceIdValue,
      conversationId: ref.externalObjectId,
      contactId: idString(contact._id) ?? idString(contact.id),
      text: message.trim(),
      html: replyHtml(message.trim()),
      type: "EMAIL",
      sentByUserId: currentUser.uid,
      sentByUserName: currentUser.name,
      email
    };
    const postSendStatus = env("LSO_HD_POST_SEND_STATUS");

    if (postSendStatus) {
      input.conversationStatus = postSendStatus;
    }

    return trpcMutate("conversations.sendMessage", input);
  },

  async markComplete({ ref }) {
    return trpcMutate("conversations.updateConversationStatus", {
      conversationId: ref.externalObjectId,
      workspaceId: workspaceId({ ref }),
      status: completeStatus
    });
  }
};

export default provider;
export { provider };
