# Architecture decision records

Short notes on decisions that aren't obvious from the code, especially the outcome of each
spike. One file per decision, numbered in order. Never rewrite an accepted record; add a new
one that supersedes it.

| #                                            | Decision                                                      | Status   |
| -------------------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-tauri-react-codemirror.md)       | Tauri 2 + React + CodeMirror 6: not Electron, not Monaco      | accepted |
| [0002](0002-ui-never-touches-the-network.md) | The UI never opens network connections; Rust does             | accepted |
| [0003](0003-conpty-without-portable-pty.md)  | Terminals use ConPTY directly (from Hearth), not portable-pty | accepted |
| [0004](0004-open-with-not-defaults.md)       | The installer offers Lathe for code files, never as a default | accepted |

## Template

```markdown
# NNNN. Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context

What problem or question forced a decision.

## Decision

What we do, concretely.

## Consequences

What gets easier, what gets harder, what to watch.
```
