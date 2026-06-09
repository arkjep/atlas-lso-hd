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
