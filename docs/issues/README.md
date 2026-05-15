# Issues

Local mirrors of GitHub issues, kept in-repo so plans, branches, and AFK agents can reference issue scope without needing network access. The GitHub tracker is the source of truth for status — these files are snapshots of the body content at the time the issue was opened.

| # | Title | Type | Blocked by |
|---|---|---|---|
| [1](01-silhouette-bbox.md) | silhouette extractor: detect content bbox correctly | AFK | — |
| [2](02-hotspot-frame-zero-only.md) | Frame generator: emit hotspot only on frame 0 | AFK | — |
| [3](03-relocate-rainbow-generator.md) | Move rainbow frame generator into MacRainbow project | AFK | — |
| [4](04-document-mask-workflow.md) | Document mask-based frame authoring path in CLAUDE.md | AFK | #1, #2, #3 |

All four were spawned from the elegance / senior-dev review of the MacRainbow shape rework session (2026-05-15). They harden the new mask-based authoring path before it gets baked into project conventions.
