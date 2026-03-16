# docs

## Demo GIF

The demo GIF in the project README is generated from an [asciinema](https://asciinema.org/) recording.

### Files

| File | Description |
|------|-------------|
| `demo.cast` | Asciinema recording (asciicast v3 JSONL) |
| `demo.gif` | Generated GIF for README |
| `demo-setup.sh` | Prepares demo files (uploads assets, waits for extraction) |

### Re-recording the demo

```bash
# 1. Prepare demo files
REEARTH_SERVE_ENDPOINT=https://reearth-serve.reearth.workers.dev bash docs/demo-setup.sh

# 2. Record a new session
REEARTH_SERVE_ENDPOINT=https://reearth-serve.reearth.workers.dev asciinema rec docs/demo.cast

# 3. (Optional) Edit docs/demo.cast to adjust timing, remove mistakes, etc.
#    The file is JSONL — each line is [delay, "o", "text"]

# 4. Generate GIF
agg docs/demo.cast docs/demo.gif --font-size 14 --theme asciinema
```

### Requirements

- [asciinema](https://asciinema.org/) — terminal recording (`brew install asciinema`)
- [agg](https://github.com/asciinema/agg) — asciicast to GIF converter (`brew install agg`)
- [reearth-serve CLI](../bin/reearth-serve.mjs) — linked via `npm link`

### Editing tips

The `.cast` file is plain JSONL. Each event line is:

```jsonl
[delay_seconds, "o", "output text with \u001b escape codes"]
```

- `delay` is relative to the previous event (in seconds)
- `"o"` = output (what appears on screen)
- Edit delays to speed up/slow down sections
- Remove lines to cut mistakes or autocomplete noise
- Split a single command output into character-by-character events for typing animation

## ADRs

Architecture Decision Records are in [`adr/`](./adr/).
