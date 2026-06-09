# ATLAS LSO HD Plugin Notes

This repo is an ATLAS task-source provider, not a standalone service. ATLAS imports `dist/index.js` from `plugins/atlas-lso-hd` when the API process starts.

Start here when debugging or changing it:

```sh
pnpm install
pnpm build
pnpm smoke
```

Use a real helpdesk conversation URL to verify the API path:

```sh
pnpm smoke -- https://hd.lowstresstrading.com/lst/dashboard/conversation/<conversationId>
```

Credentials live in this plugin's `.env`, not the root ATLAS `.env`. Set either `LSO_HD_ACCESS_TOKEN` or both `LSO_HD_PHONE` and `LSO_HD_PASSCODE`.

After changing provider code, rebuild and restart the ATLAS API. Provider modules are imported once per API process.
