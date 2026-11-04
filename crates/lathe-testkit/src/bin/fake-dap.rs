//! A fake debug adapter (DAP over stdio) for Lathe's tests. It "runs" a text file one line at
//! a time: breakpoints stop on their line, `print <text>` writes output, and stepping moves to
//! the next line. The variables are `line` (the current line number), `name` and an object
//! `config` with a child `debug`; `line`'s value can be changed. `evaluate` knows `line`,
//! `line + 1` and `name`.

use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

fn read_message(input: &mut impl BufRead) -> Option<Value> {
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            length = value.trim().parse().ok()?;
        }
    }
    let mut body = vec![0; length];
    input.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

struct Adapter {
    seq: i64,
    program: String,
    lines: Vec<String>,
    breakpoints: BTreeMap<usize, Option<String>>,
    /// The current line (1-based), 0 before starting.
    current: usize,
    line_value: i64,
    /// The launch request, answered once configuration is done (as real adapters do).
    launch_seq: Value,
}

impl Adapter {
    fn send(&mut self, mut value: Value) {
        self.seq += 1;
        value["seq"] = json!(self.seq);
        let body = value.to_string();
        let mut out = io::stdout().lock();
        let _ = write!(out, "Content-Length: {}\r\n\r\n{}", body.len(), body);
        let _ = out.flush();
    }

    fn respond(&mut self, request: &Value, body: Value) {
        let command = request["command"].clone();
        let request_seq = request["seq"].clone();
        self.send(json!({ "type": "response", "request_seq": request_seq, "success": true, "command": command, "body": body }));
    }

    fn fail(&mut self, request: &Value, message: &str) {
        let command = request["command"].clone();
        let request_seq = request["seq"].clone();
        self.send(json!({ "type": "response", "request_seq": request_seq, "success": false, "command": command, "message": message }));
    }

    fn event(&mut self, event: &str, body: Value) {
        self.send(json!({ "type": "event", "event": event, "body": body }));
    }

    /// Runs from the line after the current one; stops at a breakpoint, or after one line
    /// when stepping.
    fn run(&mut self, step: bool) {
        loop {
            self.current += 1;
            if self.current > self.lines.len() {
                self.event(
                    "output",
                    json!({ "category": "stdout", "output": "done\n" }),
                );
                self.event("exited", json!({ "exitCode": 0 }));
                self.event("terminated", json!({}));
                return;
            }
            self.line_value = self.current as i64;
            let text = self.lines[self.current - 1].clone();
            if let Some(rest) = text.trim().strip_prefix("print ") {
                self.event(
                    "output",
                    json!({ "category": "stdout", "output": format!("{rest}\n") }),
                );
            }
            if step {
                self.event(
                    "stopped",
                    json!({ "reason": "step", "threadId": 1, "allThreadsStopped": true }),
                );
                return;
            }
            if let Some(condition) = self.breakpoints.get(&self.current).cloned() {
                let hit = condition.is_none_or(|c| {
                    c.strip_prefix("line == ")
                        .and_then(|n| n.trim().parse::<usize>().ok())
                        == Some(self.current)
                });
                if hit {
                    self.event(
                        "stopped",
                        json!({ "reason": "breakpoint", "threadId": 1, "allThreadsStopped": true }),
                    );
                    return;
                }
            }
        }
    }

    fn handle(&mut self, request: &Value) -> bool {
        let args = &request["arguments"];
        match request["command"].as_str().unwrap_or("") {
            "initialize" => {
                self.respond(request, json!({
                    "supportsConfigurationDoneRequest": true,
                    "supportsConditionalBreakpoints": true,
                    "supportsEvaluateForHovers": true,
                    "supportsSetVariable": true,
                    "exceptionBreakpointFilters": [{ "filter": "uncaught", "label": "Uncaught exceptions", "default": true }]
                }));
                self.event("initialized", json!({}));
            }
            "launch" => {
                self.launch_seq = request["seq"].clone();
                self.program = args["program"].as_str().unwrap_or("").to_string();
                self.lines = std::fs::read_to_string(&self.program)
                    .unwrap_or_default()
                    .lines()
                    .map(String::from)
                    .collect();
                // Answered after configurationDone, like the real adapters.
            }
            "setBreakpoints" => {
                self.breakpoints.clear();
                let mut verified = Vec::new();
                for bp in args["breakpoints"].as_array().into_iter().flatten() {
                    let line = bp["line"].as_u64().unwrap_or(0) as usize;
                    let ok = line >= 1 && line <= self.lines.len().max(1_000);
                    if ok {
                        self.breakpoints.insert(line, bp["condition"].as_str().map(String::from));
                    }
                    verified.push(json!({ "verified": ok, "line": line }));
                }
                self.respond(request, json!({ "breakpoints": verified }));
            }
            "setExceptionBreakpoints" => self.respond(request, json!({})),
            "configurationDone" => {
                self.respond(request, json!({}));
                let request_seq = self.launch_seq.clone();
                self.send(json!({ "type": "response", "request_seq": request_seq, "success": true, "command": "launch" }));
                self.event("process", json!({ "name": self.program.clone() }));
                self.run(false);
            }
            "threads" => self.respond(request, json!({ "threads": [{ "id": 1, "name": "main" }] })),
            "stackTrace" => {
                let frame = json!({
                    "id": 1,
                    "name": "main",
                    "source": { "name": "program", "path": self.program.clone() },
                    "line": self.current,
                    "column": 1
                });
                self.respond(request, json!({ "stackFrames": [frame], "totalFrames": 1 }));
            }
            "scopes" => self.respond(request, json!({ "scopes": [{ "name": "Locals", "variablesReference": 1, "expensive": false }] })),
            "variables" => {
                let reference = args["variablesReference"].as_i64().unwrap_or(0);
                let variables = if reference == 1 {
                    json!([
                        { "name": "line", "value": self.line_value.to_string(), "type": "int", "variablesReference": 0 },
                        { "name": "name", "value": "\"fake\"", "type": "str", "variablesReference": 0 },
                        { "name": "config", "value": "{debug: true}", "type": "dict", "variablesReference": 2 }
                    ])
                } else {
                    json!([{ "name": "debug", "value": "true", "type": "bool", "variablesReference": 0 }])
                };
                self.respond(request, json!({ "variables": variables }));
            }
            "setVariable" => {
                let value = args["value"].as_str().unwrap_or("");
                match value.parse::<i64>() {
                    Ok(n) if args["name"] == "line" => {
                        self.line_value = n;
                        self.respond(request, json!({ "value": n.to_string(), "type": "int" }));
                    }
                    _ => self.fail(request, "Only line can be changed, to a number."),
                }
            }
            "evaluate" => {
                let expression = args["expression"].as_str().unwrap_or("").trim();
                let result = match expression {
                    "line" => Some(self.line_value.to_string()),
                    "line + 1" => Some((self.line_value + 1).to_string()),
                    "name" => Some("\"fake\"".to_string()),
                    _ => None,
                };
                match result {
                    Some(value) => self.respond(request, json!({ "result": value, "variablesReference": 0 })),
                    None => self.fail(request, &format!("NameError: name '{expression}' is not defined")),
                }
            }
            "next" | "stepIn" | "stepOut" => {
                self.respond(request, json!({}));
                self.run(true);
            }
            "continue" => {
                self.respond(request, json!({ "allThreadsContinued": true }));
                self.run(false);
            }
            "pause" => {
                self.respond(request, json!({}));
                self.event("stopped", json!({ "reason": "pause", "threadId": 1 }));
            }
            "disconnect" | "terminate" => {
                self.respond(request, json!({}));
                return false;
            }
            _ => self.fail(request, "not supported"),
        }
        true
    }
}

fn main() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut adapter = Adapter {
        seq: 0,
        program: String::new(),
        lines: Vec::new(),
        breakpoints: BTreeMap::new(),
        current: 0,
        line_value: 0,
        launch_seq: Value::Null,
    };
    while let Some(message) = read_message(&mut input) {
        if message["type"] == "request" && !adapter.handle(&message) {
            break;
        }
    }
}
