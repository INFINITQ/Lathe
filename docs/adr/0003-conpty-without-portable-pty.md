# 0003. Terminals use ConPTY directly (from Hearth), not portable-pty

- Status: accepted
- Date: 2026-11-03

## Context

The terminal panel and the Run button need real pseudo consoles, so that interactive programs
work: `input()`, `cin`, REPLs, colours, and `Ctrl+C`.

portable-pty (WezTerm's crate) starts the shell already running, so it can only be put in a Job
Object afterwards. Anything the shell starts in that first moment escapes the job and outlives
Stop or closing Lathe. Its last release was 2025-02, and it hard-codes ConPTY flags.

## Decision

Lathe reuses Hearth's `terminal/pty.rs` (Hearth ADR 0005), now `lathe-core/src/terminal`.

- The pseudo console is created with the `windows` crate.
- The shell starts with `CREATE_SUSPENDED`, joins a new Job Object, then resumes.
- Output is read on a thread and decoded as a UTF-8 stream; keystrokes go through a writer
  thread.

## Consequences

- Closing a terminal tab, Stop on a run, or quitting Lathe ends the whole process tree, with no
  gap.
- About 300 lines of `unsafe` Windows code, covered by tests that run real `cmd.exe` sessions.
- ConPTY's quirks are ours to handle. One example: the cursor-position request a shell sends
  at start must be answered, which the attached xterm does.
