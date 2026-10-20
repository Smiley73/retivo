# retivo-mcp-bridge

The local bridge of RETIVO's AI assistant connector. An AI assistant that runs on
your computer (Claude Code or Codex) starts it over stdio; it lists RETIVO's
read-only tools to the assistant and relays each call to your signed-in RETIVO
browser tab over a connection that stays on your computer (`127.0.0.1`). It holds
no plan data and keeps nothing.

It is one self-contained file that needs Node 24 (24.2 or later in the 24 line)
and nothing installed beside it. A RETIVO copy that offers the connector serves
the file from its own address; the **AI assistants** card under
**Settings → Preferences** shows the download command, the checksum to verify it
against and the command that adds the bridge to your assistant. The full guide is
`docs/ai-assistants.md` in the repository.

```sh
node retivo-mcp-bridge.mjs --origin https://your-retivo.example [--port 24580]
```

`--origin` is the exact address of the RETIVO tab (scheme, host and port, no
trailing slash); the bridge refuses a tab from any other origin.

Build it from a checkout with `pnpm --filter @retirement/mcp-bridge build`; the
bundle and its `THIRD-PARTY-NOTICES.txt` land in `build/`.

Licensed under the Apache License 2.0 (see `LICENSE`). The notices of the
third-party packages embedded in the bundle are in `THIRD-PARTY-NOTICES.txt`.
