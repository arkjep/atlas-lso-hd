# atlas-lso-hd

Custom LSO helpdesk task-source provider for ATLAS.

This repo builds a JavaScript module that ATLAS can load through:

```env
TASK_SOURCE_PROVIDER_MODULES=plugins/atlas-lso-hd/dist/index.js
```

The module is intentionally small: it resolves helpdesk conversation URLs into Atlas refs, fetches the conversation thread, optionally posts a completion reply, and optionally marks the conversation closed.

## Setup

```sh
pnpm install
pnpm build
```

Then configure ATLAS:

```env
TASK_SOURCE_PROVIDER_MODULES=plugins/atlas-lso-hd/dist/index.js
TASK_SOURCE_AUTO_COMPLETE_EXTERNAL=true
TASK_SOURCE_AUTO_SEND_COMPLETION_REPLIES=false

LSO_HD_TRPC_URL=https://hd-api.lowstresstrading.com/trpc
LSO_HD_ACCESS_TOKEN=...
LSO_HD_WORKSPACE_ID=LST
```

`TASK_SOURCE_AUTO_SEND_COMPLETION_REPLIES=false` means ATLAS will draft and store a reply on the task external ref, but this provider will not post it.

## API Shape

The provider uses the LST Help Desk tRPC API discovered from the deployed app:

- `conversations.getConversation`
- `conversations.sendMessage`
- `conversations.updateConversationStatus`
- `users.getUser`

Conversation URLs are expected to look like:

```txt
https://hd.lowstresstrading.com/lst/dashboard/conversation/<conversationId>
```

Set `LSO_HD_ACCESS_TOKEN` to the same bearer token the web app stores as `@lsthd/accessToken`.
