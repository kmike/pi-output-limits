# pi-output-limits

[![CI](https://github.com/kmike/pi-output-limits/actions/workflows/ci.yml/badge.svg)](https://github.com/kmike/pi-output-limits/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/github/license/kmike/pi-output-limits?color=blue)](https://github.com/kmike/pi-output-limits/blob/main/LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-8A4FFF)](https://pi.dev)

Global, configurable caps on tool output size for the [pi coding agent](https://github.com/earendil-works/pi-mono).

Pi's built-in tools truncate their own output at hardcoded limits (2000 lines / 50KB, whichever comes first). This extension re-truncates **every** tool's output — built-in *and* extension-registered — down to your own limits, before the result reaches the model's context. It works via the `tool_result` event, so there is no monkey-patching and no re-implementation of any tool.

**Installing it changes nothing by default**: the default limits are pi's own, so behavior is identical until you configure different values (and no system-prompt note is added while in no-op mode).

## Features

- One config block caps all tools (`read`, `bash`, `grep`, `find`, `ls`, subagent results, web fetches, ...)
- Per-tool overrides (e.g. stricter limits for `bash`)
- `bash` keeps the **tail** of output (where errors usually are), matching pi's native behavior; everything else keeps the head
- When truncation removes content that pi itself did not save, the full output is written to a temp file and the footer points at it — the model can always recover the rest; `read` results are the exception: they get a `Use offset=…` pointer back to the source file instead of a redundant temp copy
- For `bash`, result details are patched so the TUI shows the real truncation numbers, exactly like native truncation
- A one-line note is appended to the system prompt so the model knows the real caps — but only when limits are actually lowered (built-in tool descriptions still quote pi's higher limits — patching those would require re-registering every tool for cosmetic gain)
- Limits set *above* pi's built-ins can't raise built-in tool caps, so those trigger a **warning to you** at session start instead of costing system-prompt tokens

## Install

```bash
pi install npm:pi-output-limits
```

To track a specific branch or commit instead, install from git (frozen at the
ref; won't auto-update with `pi update`):

```bash
pi install git:github.com/kmike/pi-output-limits@main
```

Or load once for a session from a local checkout:

```bash
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
| `tools` | `{}` | Per-tool overrides of `maxLines` / `maxBytes` (any tool name; unknown/third-party names are fine) |
| `tailTools` | `["bash"]` | Tools whose results keep the **end** of the output instead of the beginning; additive on top of the default `bash` |

All values must be positive integers. Editing the settings is a plain JSON edit of the file named above — no extension-specific commands or environment variables are involved.

**When changes take effect:** the config is read at session start, so start a new pi session (or run `/reload`) after editing the settings.

## How it works

```
tool executes (built-in truncation at 50KB/2000 may or may not fire)
  └─► tool_result event
        └─► pi-output-limits re-truncates to your limits,
            strips the built-in footer, saves full output to a temp
            file if needed (read: footer points back at the source
            file with the next offset instead), appends a footer
            with real counts + recovery path,
            patches details.truncation for the TUI
              └─► result goes to the model's context
```

## Limits at or above pi's built-ins

- **Exactly pi's limits (the default):** complete no-op. When a built-in tool truncates, its native footer and TUI warning pass through untouched.
- **Higher than pi's limits:** built-in tools still discard anything beyond 2000 lines / 50KB before this extension sees the result, so their native truncation stands (footer preserved) — the extension warns you at session start that such values are ineffective for built-in tools. Higher values remain fully effective for **third-party/extension-registered tools**, which have no built-in caps (and are not warned about).

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Tests exercise the extension through a minimal fake of pi's extension API, using the real `truncateHead`/`truncateTail` from `@earendil-works/pi-coding-agent`. CI runs typecheck + tests on Node 22 and 24 (pi requires Node >= 22.19).

## Limitations

- Limits can't be **raised** for built-in tools: `read`, `bash`, etc. discard output beyond 2000 lines / 50KB before this extension sees it, so its caps are effectively ceilings (higher values still work for third-party tools, which have no built-in caps).
- Non-text content blocks (images and other media) pass through untouched.

## License

MIT
