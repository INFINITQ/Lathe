# Spike 3: Jupyter kernels from Rust on Windows (2026-11-03)

**Verdict:** `jupyter-zmq-client` works. All 22 scenarios passed, and no Python bridge is needed.

Tested with Python 3.14.7 in a venv: ipykernel 7.4.0, jupyter_client 8.10, pyzmq 27.2.
The spike source is in the session scratchpad (`spike-jupyter\kernel-spike\src\{win,kernel,client}.rs`).

## Crates

```toml
jupyter-zmq-client = { version = "=3.0.1", default-features = false, features = ["tokio-runtime", "ring"] }
jupyter-protocol = "=2.0.3"
```

The crate refuses to compile unless it gets exactly one runtime and one HMAC backend.

## Launch recipe

1. **Connection file:** five free ports (`peek_ports_with_listeners(127.0.0.1, 5)`), a 32-byte hex
   key, `hmac-sha256`, `transport: tcp`.
2. **Interrupt event:**
   - `CreateEventW` with an inheritable SECURITY_ATTRIBUTES, auto-reset, passed as
     `JPY_INTERRUPT_EVENT=<handle as decimal>`.
   - `DuplicateHandle(self, SYNCHRONIZE, inherit)`, passed as `JPY_PARENT_PID=<handle>`. This is a
     handle the kernel waits on, not a pid.
3. **Spawn:** `<env python> -m ipykernel_launcher -f <connection file>`, with no shell,
   `CREATE_NO_WINDOW`, NUL stdin, piped stdout/stderr, cwd set to the notebook's folder, and
   `PYDEVD_DISABLE_FILE_VALIDATION=1`.
   - The kernelspec's `argv[0]` is a bare "python": map it to the interpreter of the environment
     that owns the spec, never to PATH.
4. **After spawn:**
   - Drop the port listeners.
   - Make the event non-inheritable again (`SetHandleInformation`) and close our copy of the
     parent handle.
   - Put the child in a Job Object (`KILL_ON_JOB_CLOSE`). A venv's `python.exe` is a launcher, so
     the real kernel is a grandchild.
5. **Connect:**
   - Connect iopub first and wait at most 2 s for `iopub_welcome`; only the first subscriber gets
     it.
   - Then connect shell and stdin with the same identity, control and heartbeat, and send
     `kernel_info_request`.
   - Race the connect against the process exiting, so a crash shows its stderr.
   - Readiness takes about 0.7 s (1.0 s cold).

## Messages

- **A cell is done** only after both `execute_reply` and iopub `status: idle` for its msg_id. They
  arrive in either order.
- **Routing:** register a route before sending (to catch the first `busy`), then route by
  `parent_header.msg_id`.
- **matplotlib:** works without magics (inline backend): `display_data` with `image/png`.
- **Errors:** an `error` message carries the ANSI traceback. Requests queued behind it get
  `status: aborted` (Run all stops).
- **`input()`:** `input_request` arrives on stdin. Answer with `InputReply.as_child_of(request)`
  (`password` for getpass). `allow_stdin: false` makes `input()` raise.
- **Completion and inspect:** `cursor_pos` counts Unicode code points, not UTF-16 units.
- **Warm-up:** the first completion takes 0.5–1.5 s (Jedi), so send a throwaway one after start.
- **Output outside iopub:** `os.system`, C-level printing and child processes write to the kernel's
  stdout pipe, not iopub. Drain the pipe and show it, decoding with the console code page.
- **Feature flags:** ipykernel 7's `supported_features` (debugger, subshells) is lost in
  jupyter-protocol's typed reply. Read the raw JSON.

## Interrupt

| Method                          | Busy loop                            | `time.sleep(30)`         | `input()`  |
| ------------------------------- | ------------------------------------ | ------------------------ | ---------- |
| `interrupt_request` on control  | no effect (`interrupt_mode: signal`) | no effect                | no effect  |
| `SetEvent(JPY_INTERRUPT_EVENT)` | 8–11 ms                              | only when the sleep ends | 15–29 ms   |
| Console Ctrl+C helper           | not tested                           | 23 ms                    | not tested |

- **Plan:**
  1. Send `interrupt_request` only when the spec says `interrupt_mode: message`.
  2. Otherwise call `SetEvent`.
  3. If the cell isn't idle after ~500 ms, run the Ctrl+C helper.
- **Ctrl+C helper:** a separate process (Lathe re-launched with a flag) does `FreeConsole` →
  `AttachConsole(kernel pid)` → `SetConsoleCtrlHandler(NULL, TRUE)` →
  `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)`. The kernel needs its hidden console
  (`CREATE_NO_WINDOW`, not `DETACHED_PROCESS`).

## Restart and shutdown

- **Shutdown:** `shutdown_request` (restart false) gets a reply in about 5 ms; the process exits in
  about 0.5 s, or 59 ms if we drop our sockets right after the reply.
- **Restart:** `restart: true` just exits; Lathe relaunches it (same ports work).
  - It takes 0.7 s.
  - zmq.rs does **not** reconnect shell/control/stdin, so rebuild the whole client.
- **Cleanup:** killing the launcher leaves `conhost.exe` and the kernel's children running.
  `TerminateJobObject` kills the whole tree in 3 ms. If Lathe dies, the Job Object or
  `JPY_PARENT_PID` ends the kernel in about 13–35 ms.

## Kernelspec discovery (jupyter_core 5.9 order)

1. Each entry of `JUPYTER_PATH`, split on `;`.
2. `<sys.prefix>\share\jupyter` (first for venv and conda envs), `%APPDATA%\jupyter`,
   `%APPDATA%\Python\share\jupyter`.
3. `%PROGRAMDATA%\jupyter`, only if `JUPYTER_USE_PROGRAMDATA` is set.

Kernel names are folder names, lower-cased; the first `kernel.json` wins. The crate's
`list_kernelspecs()` misses `sys.prefix`, so write our own.

## Security

There is no encryption: loopback TCP plus the HMAC key only, because neither pyzmq IPC nor
zmq.rs CURVE is available on Windows.
