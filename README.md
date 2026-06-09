# atlas-lso-hd

Custom LSO helpdesk task-source provider for ATLAS.

This repo builds a JavaScript module that ATLAS can load through:

```env
TASK_SOURCE_PROVIDER_MODULES=plugins/atlas-lso-hd/dist/index.js
```

The module is intentionally small: it resolves helpdesk URLs into ticket refs, fetches the ticket thread, optionally posts a completion reply, and optionally marks the ticket complete.

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

LSO_HD_BASE_URL=https://helpdesk.example.com/api
LSO_HD_API_TOKEN=...
```

`TASK_SOURCE_AUTO_SEND_COMPLETION_REPLIES=false` means ATLAS will draft and store a reply on the task external ref, but this provider will not post it.

## API Shape

The defaults assume a REST-ish helpdesk:

- `GET /tickets/:id`
- `GET /tickets/:id/messages`
- `POST /tickets/:id/replies` with `{ body }`
- `PATCH /tickets/:id` with `{ status: "completed" }`

Override paths and methods with the `LSO_HD_*` env vars in `.env.example`.
