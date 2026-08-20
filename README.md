# pi-output-limits

Global, configurable caps on tool output size for the [pi coding agent](https://github.com/earendil-works/pi-mono).

Pi's built-in tools truncate their own output at hardcoded limits (2000 lines / 50KB, whichever comes first). This extension re-truncates **every** tool's output — built-in *and* extension-registered — down to your own limits, before the result reaches the model's context. It works via the `tool_result` event, so there is no monkey-patching and no re-implementation of any tool.

**Installing it changes nothing by default**: the default limits are pi's own, so behavior is identical until you configure different values (and no system-prompt note is added while in no-op mode).

## Features

- One config block caps all tools (`read`, `bash`, `grep`, `find`, `ls`, subagent results, web fetches, ...)
- Per-tool overrides (e.g. stricter limits for `bash`)
- `bash` keeps the **tail** of output (where errors usually are), matching pi's native behavior; everything else keeps the head
- When truncation removes content that pi itself did not save, the full output is written to a temp file and the footer points at it — the model can always recover the rest
- For `bash`, result details are patched so the TUI shows the real truncation numbers, exactly like native truncation
- A one-line note is appended to the system prompt so the model knows the real caps — but only when you've actually configured non-default limits (built-in tool descriptions still quote pi's higher limits — patching those would require re-registering every tool for cosmetic gain)

## Install

```bash
# From a local checkout
pi install /path/to/pi-output-limits

# Or load once for a session
pi -e /path/to/pi-output-limits/src/index.ts
```

## Configuration

Add an `outputLimits` block to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` in a trusted project (project values win):

```json
{
  "outputLimits": {
    "maxLines": 500,
    "maxBytes": 16384,
    "tools": {
      "bash": { "maxLines": 300, "maxBytes": 8192 }
    },
    "tailTools": ["bash"]
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `maxLines` | `2000` (pi's built-in) | Max lines per tool result |
| `maxBytes` | `51200` (pi's built-in 50KB) | Max bytes per tool result (whichever limit is hit first wins) |
| `tools` | `{}` | Per-tool overrides of `maxLines` / `maxBytes` |
| `tailTools` | `["bash"]` | Tools whose results keep the **end** of the output instead of the beginning |

## How it works

```
tool executes (built-in truncation at 50KB/2000 may or may not fire)
  └─► tool_result event
        └─► pi-output-limits re-truncates to your limits,
            strips the built-in footer, saves full output to a temp
            file if needed, appends a footer with real counts + path,
            patches details.truncation for the TUI
              └─► result goes to the model's context
```

## Limits at or above pi's built-ins

- **Exactly pi's limits (the default):** complete no-op. When a built-in tool truncates, its native footer and TUI warning pass through untouched.
- **Higher than pi's limits:** built-in tools still discard anything beyond 2000 lines / 50KB before this extension sees the result, so their native truncation stands (footer preserved). Higher values only make a difference for **extension-registered tools**, which have no built-in caps. The system-prompt note says as much when you configure this.

If you need *higher* limits for a specific built-in tool, override that tool via
`create*ToolDefinition` + `registerTool` (see [@arcanemachine/pi-read](https://github.com/arcanemachine/pi-read)
for an example of that pattern applied to `read`).

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Tests exercise the extension through a minimal fake of pi's extension API, using the real `truncateHead`/`truncateTail` from `@earendil-works/pi-coding-agent`. CI runs typecheck + tests on Node 20 and 22.

## Limitations

- Non-text content blocks (images and other media) pass through untouched.

## License

MIT
