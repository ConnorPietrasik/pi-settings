# @cpzombie/pi-settings

[pi](https://pi.dev) coding agent extensions for personal setup convenience.

## Extensions

### `raw-context-counter`

Replaces the built-in TUI footer with a version where the context counter
shows **raw token counts** (e.g. `25k/200k (auto)`) instead of a
percentage (e.g. `12.5%/200k (auto)`) — the absolute count is more useful
than a percentage, and rounding follows the built-in footer's token
formatting (24,600 tokens renders as `25k`).

Everything else mirrors the built-in footer: pwd + git branch + session
name line, token stats (cache/cost omitted — local-only), color thresholds
(>90% red, >70% yellow), model name + thinking level on the right, and the
extension status line. It is a line-for-line mirror of the built-in footer
internals, so a pi release that changes the footer may need a sync pass.

### `setup-sync`

Seeds the personal config bundled under `setup/` into the agent dir
(`~/.pi/agent`) on session start:

- `setup/models.json` → custom providers (local llama-cpp server on
  `localhost:8080` with `Qwen3.8-27B-Q8`)
- `setup/settings.json` → compaction defaults (`enabled`,
  `keepRecentTokens: 60000`)

Merge rules (never clobber): bundled providers are added only if that
provider isn't already defined in `models.json`; for `settings.json`, only
missing leaf keys are filled in. If your files already exist with your own
values, they win. New values take effect on the next pi start.

**LLM server address.** The bundled provider's `baseUrl` is
machine-specific (default `http://localhost:8080/v1`). When the provider is
first seeded on a machine:

1. `PI_LLM_BASE_URL=http://gpu-box:8080/v1` env var wins (non-interactive
   runs, print mode, CI)
2. otherwise the TUI asks once at startup — Enter the address, or Esc to
   keep the default
3. a non-interactive first run with no env var gets the bundled default
   (`http://localhost:8080/v1`)
4. afterwards, use the **`/llm-setup`** command to set a new address or
   remove the provider entirely

If the provider is already defined in your `models.json`, nothing is asked
and nothing is changed.

Edit the JSON files under `setup/` in this repo and bump the version to
change what gets seeded — or just edit your local files directly to override.

Note: the bundled model config points at a **local** llama-cpp server; on a
machine without one the model will appear in `/model` but not connect.

## Install

```bash
pi install npm:@cpzombie/pi-settings
# or pinned to a version:
pi install npm:@cpzombie/pi-settings@0.1.0
```

Uninstall (or `pi remove` then `/reload` in an interactive session):

```bash
pi remove npm:@cpzombie/pi-settings
```

Note: removing the package does not undo the settings that were already
seeded into `~/.pi/agent/` — delete the provider from `models.json` and the
`compaction` block from `settings.json` manually if you want that.

## Notes

- Extensions are TypeScript, loaded by pi via jiti — no build step.
- `@earendil-works/pi-coding-agent`, `-pi-ai`, and `-pi-tui` are peer
  dependencies provided by your pi installation; they are not bundled here.
