#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(pluginRoot, "dist", "index.js");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const conversationUrl = args[0];

function loadLocalEnv() {
  const envPath = path.join(pluginRoot, ".env");

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

function env(name) {
  return process.env[name]?.trim() || "";
}

function hasLoginCredentials() {
  return Boolean(env("LSO_HD_ACCESS_TOKEN") || env("LSO_HD_API_TOKEN") || (env("LSO_HD_PHONE") && (env("LSO_HD_PASSCODE") || env("LSO_HD_PASSWORD"))));
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function contactSummary(metadata) {
  const contact = asRecord(asRecord(metadata).contact);
  const emails = Array.isArray(contact.emails) ? contact.emails.filter((email) => typeof email === "string") : [];
  const phones = Array.isArray(contact.phones) ? contact.phones.filter((phone) => typeof phone === "string") : [];

  return [
    contact.name ? `name=${contact.name}` : null,
    contact.email ? `email=${contact.email}` : null,
    emails.length ? `emails=${emails.length}` : null,
    contact.phone ? "phone=present" : null,
    phones.length ? `phones=${phones.length}` : null
  ].filter(Boolean).join(", ") || "none";
}

function messagePreview(message) {
  return String(message.text || message.html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

loadLocalEnv();

if (!existsSync(distPath)) {
  fail("Missing dist/index.js. Run `pnpm build` from plugins/atlas-lso-hd first.");
} else if (!hasLoginCredentials()) {
  fail("Missing LSO helpdesk credentials. Set LSO_HD_ACCESS_TOKEN, or set LSO_HD_PHONE and LSO_HD_PASSCODE in plugins/atlas-lso-hd/.env.");
} else {
  const moduleExports = await import(pathToFileURL(distPath).href);
  const provider = moduleExports.provider ?? moduleExports.default;

  if (!provider?.id) {
    fail("dist/index.js did not export an ATLAS task-source provider.");
  } else {
    console.log(`provider=${provider.id}`);
    console.log(`name=${provider.name ?? "(unnamed)"}`);
    console.log(`automation.markComplete=${Boolean(provider.automation?.markCompleteOnTaskComplete)}`);
    console.log(`automation.postCompletionReply=${Boolean(provider.automation?.postCompletionReplyOnTaskComplete)}`);

    if (!conversationUrl) {
      console.log("No conversation URL supplied. Provider load and credential presence checks passed.");
      console.log("To verify helpdesk access, run: pnpm smoke -- https://hd.lowstresstrading.com/lst/dashboard/conversation/<conversationId>");
    } else {
      console.log(`url=${conversationUrl}`);
      const ref = await provider.resolveUrl({ url: conversationUrl });

      if (!ref) {
        fail("Provider did not recognize that URL as an LSO helpdesk conversation.");
      } else {
        console.log(`ref.provider=${ref.provider}`);
        console.log(`ref.externalObjectId=${ref.externalObjectId}`);
        console.log(`ref.externalTitle=${ref.externalTitle ?? "(untitled)"}`);
        console.log(`ref.externalStatus=${ref.externalStatus ?? "(unknown)"}`);
        console.log(`ref.contact=${contactSummary(ref.metadata)}`);

        const thread = await provider.fetchThread({
          ref,
          task: { id: "smoke", title: "Smoke test", description: "", urls: [conversationUrl], status: "open" },
          user: { id: "smoke", email: "smoke@atlas.local", name: "ATLAS Smoke Test" }
        });

        console.log(`thread.title=${thread?.title ?? "(untitled)"}`);
        console.log(`thread.messages=${thread?.messages?.length ?? 0}`);

        for (const message of (thread?.messages ?? []).slice(-3)) {
          console.log(`message.${message.id ?? "unknown"}=${messagePreview(message)}`);
        }
      }
    }
  }
}
