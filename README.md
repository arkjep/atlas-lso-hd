# atlas-lso-hd

Custom LSO helpdesk task-source provider for ATLAS.

This repo builds a JavaScript task-source provider module that ATLAS discovers automatically when the repo is checked out under `plugins/atlas-lso-hd`.

The module is intentionally small: it resolves helpdesk conversation URLs into Atlas refs, fetches the conversation thread, optionally posts a completion reply, and optionally marks the conversation closed.

## Setup

```sh
pnpm install
pnpm build
```

Then configure this plugin's `.env`:

```env
LSO_HD_PHONE=...
LSO_HD_PASSCODE=...
```

Put those two values in this plugin's own `.env`, not in the ATLAS `.env`.

You can also set `LSO_HD_ACCESS_TOKEN` directly instead of `LSO_HD_PHONE` and `LSO_HD_PASSCODE`. The direct token is the same bearer token the web app stores as `@lsthd/accessToken`; when it is omitted, this module logs in lazily through the helpdesk API and caches the returned token in memory for the current ATLAS process.

If a cached or configured token expires and the API returns `401`, the module clears its cached token, logs in again with `LSO_HD_PHONE` and `LSO_HD_PASSCODE`, and retries the request once.

When an ATLAS task with a linked helpdesk conversation is completed, this provider asks ATLAS to draft a completion reply and marks the helpdesk conversation closed. It does not send the email reply automatically.

## How ATLAS Runs It

ATLAS does not start this plugin as a separate server. The API discovers and imports the built module at:

```txt
plugins/atlas-lso-hd/dist/index.js
```

That means the normal local run sequence is:

```sh
cd plugins/atlas-lso-hd
pnpm install
pnpm build
pnpm smoke

cd ../..
pnpm dev
```

Use `pnpm smoke` any time an agent or developer needs to answer "is the LSO HD plugin installed, built, and credentialed?" without starting all of ATLAS. It loads the same `dist/index.js` file ATLAS imports and checks for either `LSO_HD_ACCESS_TOKEN` or `LSO_HD_PHONE` plus `LSO_HD_PASSCODE`.

To verify a specific helpdesk conversation end to end:

```sh
cd plugins/atlas-lso-hd
pnpm build
pnpm smoke -- https://hd.lowstresstrading.com/lst/dashboard/conversation/<conversationId>
```

That command resolves the URL, fetches the thread, and prints the conversation id, title, status, contact summary, message count, and a short preview of the latest messages.

If ATLAS is already running and a task link is not syncing, rebuild this plugin and restart the API process. Task-source providers are imported once per API process.

## API Shape

The provider uses the LST Help Desk tRPC API discovered from the deployed app:

- `conversations.getConversation`
- `conversations.sendMessage`
- `conversations.updateConversationStatus`
- `auth.checkPhone`
- `auth.login`
- `users.doLogin`
- `users.getUser`

Conversation URLs are expected to look like:

```txt
https://hd.lowstresstrading.com/lst/dashboard/conversation/<conversationId>
```

The helpdesk login form calls the passcode a code, but the API expects it as `password`; this module maps `LSO_HD_PASSCODE` to that API field.

## Attachments

Thread messages include URL-free `attachments` descriptors (id, name, MIME type, byte size and optional content ID), including messages with no text. `fetchAttachment({ ref, task, user, messageId, attachmentId })` re-fetches the authorized HelpDesk conversation and resolves only an attachment belonging to that message. Internal notes remain excluded unless explicitly configured.

Downloads use HelpDesk's existing presign redirect endpoint, then the exact configured LST attachment storage hostname. They do not forward HelpDesk credentials, expose signed URLs, or save bytes. Limits: 20 descriptors per message, 10 MiB per file, 30 seconds per download, one controlled HTTPS redirect, matching MIME/size and PNG/JPEG/PDF signatures where applicable. Download errors omit upstream response bodies and URLs.

Run `pnpm test` for mocked metadata, membership, redirect, size, MIME and credential-leakage regression tests. A live smoke fetch may display customer text; use summary-only checks when inspecting production conversations.
