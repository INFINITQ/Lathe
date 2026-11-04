# Spike 4: debug adapters on Windows (2026-11-03)

**Verdict: all three adapters work on this PC with nothing installed.**

- debugpy over stdio.
- One reused js-debug server over TCP.
- CodeLLDB over TCP with `--connect`.

Build ConPTY-backed `runInTerminal` and child-session `startDebugging` handling from day one.

The harness (Node) and full logs are in the session scratchpad: `spike-dap\harness\dap.mjs` and
`spike.mjs`. Downloads were SHA-256-checked against PyPI and GitHub digests:

- debugpy universal wheel: `a9e9d355…`
- debugpy cp314 wheel: `d593a330…`
- js-debug: `27dab929…`
- CodeLLDB: `a916e509…`

## Client rules (all adapters)

- **Startup order:** send `launch`/`attach` without waiting for its reply. Wait for the
  `initialized` event, then send setBreakpoints → setExceptionBreakpoints → configurationDone.
  All three adapters answer `launch` only after configurationDone.
- **Replies:** match responses on `request_seq` only (CodeLLDB's error responses have
  `command: ""`).
- **Exception filters:** send each adapter's advertised defaults (debugpy `uncaught`, CodeLLDB
  `cpp_throw`); `[]` switches them off.
- **Output events:** they arrive in fragments, so append them to the console rather than treating
  each as a line. Drop `category:"telemetry"`.
- **Ids and paths:** a threadId can be `0`. Paths can come back as `c:\…`, so compare them
  case-insensitively.
- **Adapter output:** always drain the adapter's stdout/stderr into a log. CodeLLDB prints Python
  tracebacks there; debugpy over TCP copies program output there.
- **Shutdown:** send `disconnect`, close the adapter's stdin (stdio adapters exit in about 100 ms),
  then kill the Job Object after a grace period.

## Python: debugpy 1.8.22

- **Command:** `<real python> -I <tools>\debugpy\adapter` over stdio.
  - TCP (`--host 127.0.0.1 --port N`) also works, and the adapter exits after disconnect.
  - Resolve PyManager's shim (`C:\Program Files\PyManager\python.exe` starts
    `…\pythoncore-3.14-64\python.exe` as a child) to `sys.executable` once.
- **Launch:** `{type:"debugpy", request:"launch", program, cwd, args:[],
console:"internalConsole"|"integratedTerminal", justMyCode:true, showReturnValue:true}`.
- **`runInTerminal`:** `{kind:"integrated", cwd, env:{}, args:[python, <tools>\debugpy\launcher,
"<port>", "--", program, …]}`. Reply `{processId}` straight away; stdout and `input()` work in a
  ConPTY.
- **Attach:** `python <tools>\debugpy --listen 127.0.0.1:N --wait-for-client app.py`, then
  `attach {justMyCode}`.
- **Performance:** the universal wheel only has compiled speedups for Python 3.9.
  - A breakpoint inside a hot loop made it 100× slower: 0.055 s became 5.8 s (4.6 s with the
    cp314 wheel).
  - Otherwise there was no overhead. Precompile its `__pycache__` at install time.
- **Variables:** lists expand to `0=…`, `len()=…` and "special variables"; `(return) compute = 46`
  appears after `next`. Evaluate errors come back as `success:false` with `"NameError: …"`.

## JavaScript / TypeScript: vscode-js-debug 1.140.0

- **Command:** `node <tools>\js-debug\src\dapDebugServer.js 0 127.0.0.1`, then read
  `Debug server listening at 127.0.0.1:PORT` from its stdout.
- **Launch:** `{type:"pwa-node", request:"launch", program, cwd, runtimeExecutable:<node.exe>,
console:"internalConsole", skipFiles:["<node_internals>/**"]}`. Always pass `cwd`.
- **`startDebugging`:** `{request:"launch", configuration:{type:"pwa-node", __pendingTargetId}}`.
  - Reply `{}`, then open a **second TCP connection** to the same port.
  - On it, send initialize, then launch with that configuration unchanged, then the normal
    startup order.
  - Breakpoints and variables happen on the child session.
- **`integratedTerminal`:** runInTerminal brings `env` (`NODE_OPTIONS` bootloader,
  `VSCODE_INSPECTOR_OPTIONS`); merge it into the terminal environment.
- **TypeScript:** Node's own type stripping runs `.ts` files with breakpoints bound correctly.
- **Quirks:**
  - Breakpoints come back provisional first; a later `breakpoint` event verifies them.
  - The child sends `initialized` twice.
  - Many `loadedSource` events arrive; ignore them.
  - A failed evaluate's `message` is "undefined": show `body.error.format`.
  - The server handles many sessions; reuse one or kill it.

## C++: CodeLLDB 1.12.3 (LLDB 22.1.8)

- **Command:** `<tools>\extension\adapter\codelldb.exe --connect <port Lathe listens on> --settings
{"sourceLanguages":["cpp"]}`.
  - It uses only its bundled `liblldb.dll` and `python312.dll`: no system Python, no missing DLLs.
- **Launch:** `{type:"lldb", request:"launch", program, cwd, args:[], terminal:"console"|"integrated",
sourceLanguages:["cpp"]}`.
- **Never use stdio transport with `terminal:"console"`:** the program's output lands inside the
  DAP stream.
  - TCP with console works, with program I/O on codelldb's own pipes.
  - `integrated` asks runInTerminal for `codelldb-launch.exe --connect=127.0.0.1:N`, and that
    needs a ConPTY. `cwd:""` means "not set".
- **MSVC builds:** `cl /nologo /Zi /Od /EHsc /std:c++20 main.cpp /Fe:main.exe /link /DEBUG` inside
  the cached VsDevCmd environment.
  - The environment takes 1.4 s, so cache it; the compile takes 0.5 s.
  - STL values are readable: `std::vector` expands to `[0]…`, `std::map` to `{first, second}`, and
    `std::string` shows its text.
- **Expressions:**
  - The simple evaluator handles `nums[2]` and `pt.x + 1`.
  - `counts["beta"]` and `nums.size()` fail.
  - In the REPL, a `?` prefix evaluates an expression; plain text is an LLDB command.
- **Quirks:**
  - Before the module loads, breakpoints report `verified:true` with 0 locations.
  - Thread ids are Windows thread ids.
  - C runtime frames are `origin:"disassembly"` with a `sourceReference`.
  - Over TCP, codelldb never exits by itself.

## Warm timings (ms)

| Adapter         | Ready | Launch → stopped | Variables | Next | Continue → end |
| --------------- | ----- | ---------------- | --------- | ---- | -------------- |
| debugpy (stdio) | ~400  | 1214             | 2         | 1    | 560            |
| js-debug        | 113   | 213 (.ts 251)    | 3         | 3    | 2              |
| CodeLLDB (TCP)  | ~260  | 103–192          | 19        | 1–2  | 7              |
