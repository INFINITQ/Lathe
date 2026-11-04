//! A fake language server for Lathe's tests, for `.fake` files (plain text to Lathe).
//!
//! - `define NAME` defines a symbol, and every `NAME` elsewhere refers to it.
//! - `FIXME` is a warning, with a quick fix that turns it into `DONE`; `ERROR` is an error.
//! - Typing `CRASH_NOW` makes the server exit with code 1 (to test restarts).
//! - Formatting removes trailing spaces.
//!
//! It asks the client for its `fake` configuration once initialized, and logs the answer to
//! stderr, so tests can check that server-to-client requests get answered.

use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

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

fn write_message(value: &Value) {
    let body = value.to_string();
    let mut out = io::stdout().lock();
    let _ = write!(out, "Content-Length: {}\r\n\r\n{}", body.len(), body);
    let _ = out.flush();
}

fn uri_to_path(uri: &str) -> PathBuf {
    let rest = uri.trim_start_matches("file:///");
    let bytes = rest.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&rest[i + 1..i + 3], 16)
        {
            decoded.push(byte);
            i += 3;
            continue;
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    PathBuf::from(String::from_utf8_lossy(&decoded).replace('/', "\\"))
}

fn path_to_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let (drive, rest) = text.split_at(1);
    format!("file:///{}%3A{}", drive.to_lowercase(), &rest[1..])
}

fn key(uri: &str) -> String {
    uri_to_path(uri).to_string_lossy().to_lowercase()
}

struct Server {
    root: Option<PathBuf>,
    /// Open documents by path key: (uri, text).
    docs: BTreeMap<String, (String, String)>,
    next_id: i64,
}

fn utf16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Whole-word occurrences of `word` in `text`, as (line, start, end) in UTF-16 units.
fn occurrences(text: &str, word: &str) -> Vec<(usize, usize, usize)> {
    let mut found = Vec::new();
    if word.is_empty() {
        return found;
    }
    for (n, line) in text.split('\n').enumerate() {
        let mut from = 0;
        while let Some(at) = line[from..].find(word) {
            let start = from + at;
            let end = start + word.len();
            let before = line[..start].chars().next_back();
            let after = line[end..].chars().next();
            let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
            if boundary(before) && boundary(after) {
                found.push((n, utf16(&line[..start]), utf16(&line[..end])));
            }
            from = end;
        }
    }
    found
}

fn range(line: usize, start: usize, end: usize) -> Value {
    json!({ "start": { "line": line, "character": start }, "end": { "line": line, "character": end } })
}

fn word_at(text: &str, line: usize, character: usize) -> String {
    let Some(line) = text.split('\n').nth(line) else {
        return String::new();
    };
    let chars: Vec<char> = line.chars().collect();
    let mut units = 0;
    let mut index = chars.len();
    for (i, c) in chars.iter().enumerate() {
        if units >= character {
            index = i;
            break;
        }
        units += c.len_utf16();
    }
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut start = index;
    while start > 0 && is_word(chars[start - 1]) {
        start -= 1;
    }
    let mut end = index;
    while end < chars.len() && is_word(chars[end]) {
        end += 1;
    }
    chars[start..end].iter().collect()
}

/// `define NAME` on a line: the name and where it starts (UTF-16).
fn definition(line: &str) -> Option<(&str, usize)> {
    let at = line.find("define ")?;
    let name = line[at + 7..]
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .next()
        .filter(|n| !n.is_empty())?;
    Some((name, utf16(&line[..at + 7])))
}

impl Server {
    /// Every `.fake` file: open ones as they are in the editor, the rest from disk.
    fn files(&self) -> Vec<(String, String)> {
        let mut files: BTreeMap<String, (String, String)> = self.docs.clone();
        if let Some(root) = &self.root
            && let Ok(entries) = std::fs::read_dir(root)
        {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "fake") {
                    let k = path.to_string_lossy().to_lowercase();
                    files.entry(k).or_insert_with(|| {
                        (
                            path_to_uri(&path),
                            std::fs::read_to_string(&path).unwrap_or_default(),
                        )
                    });
                }
            }
        }
        files.into_values().collect()
    }

    fn text(&self, uri: &str) -> String {
        self.docs
            .get(&key(uri))
            .map(|(_, t)| t.clone())
            .unwrap_or_default()
    }

    fn publish(&self, uri: &str, text: &str) {
        let mut diagnostics = Vec::new();
        for (word, severity, message) in [
            ("FIXME", 2, "FIXME: finish this"),
            ("ERROR", 1, "Something is wrong here"),
        ] {
            for (line, start, end) in occurrences(text, word) {
                diagnostics.push(json!({ "range": range(line, start, end), "severity": severity, "source": "fake", "message": message }));
            }
        }
        write_message(
            &json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": uri, "diagnostics": diagnostics } }),
        );
    }

    fn handle(&mut self, message: &Value) -> Option<Value> {
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        let uri = params["textDocument"]["uri"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
        let character = params["position"]["character"].as_u64().unwrap_or(0) as usize;
        match method {
            "initialize" => {
                self.root = params["rootUri"].as_str().map(uri_to_path);
                Some(json!({
                    "capabilities": {
                        "textDocumentSync": 1,
                        "completionProvider": { "triggerCharacters": ["."] },
                        "hoverProvider": true,
                        "definitionProvider": true,
                        "referencesProvider": true,
                        "renameProvider": { "prepareProvider": true },
                        "documentFormattingProvider": true,
                        "documentSymbolProvider": true,
                        "workspaceSymbolProvider": true,
                        "codeActionProvider": { "codeActionKinds": ["quickfix"] },
                        "documentHighlightProvider": true,
                        "signatureHelpProvider": { "triggerCharacters": ["("] },
                        "inlayHintProvider": true
                    },
                    "serverInfo": { "name": "fake-lsp", "version": "1.0" }
                }))
            }
            "initialized" => {
                self.next_id += 1;
                write_message(
                    &json!({ "jsonrpc": "2.0", "id": self.next_id, "method": "workspace/configuration", "params": { "items": [{ "section": "fake" }] } }),
                );
                None
            }
            "textDocument/didOpen" | "textDocument/didChange" => {
                let text = if method == "textDocument/didOpen" {
                    params["textDocument"]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                } else {
                    params["contentChanges"][0]["text"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                };
                if text.contains("CRASH_NOW") {
                    eprintln!("fake-lsp: crashing on purpose");
                    std::process::exit(1);
                }
                self.docs.insert(key(&uri), (uri.clone(), text.clone()));
                self.publish(&uri, &text);
                None
            }
            "textDocument/didClose" => {
                self.docs.remove(&key(&uri));
                None
            }
            "textDocument/completion" => Some(json!([
                { "label": "fakeAlpha", "kind": 3, "detail": "fn fakeAlpha()" },
                { "label": "fakeBeta", "kind": 6, "detail": "let fakeBeta" }
            ])),
            "textDocument/hover" => {
                let word = word_at(&self.text(&uri), line, character);
                if word.is_empty() {
                    return Some(Value::Null);
                }
                Some(
                    json!({ "contents": { "kind": "markdown", "value": format!("**fake hover** for `{word}`") } }),
                )
            }
            "textDocument/definition" => {
                let word = word_at(&self.text(&uri), line, character);
                for (file, text) in self.files() {
                    for (n, l) in text.split('\n').enumerate() {
                        if let Some((name, start)) = definition(l)
                            && name == word
                        {
                            return Some(
                                json!({ "uri": file, "range": range(n, start, start + utf16(name)) }),
                            );
                        }
                    }
                }
                Some(Value::Null)
            }
            "textDocument/references" => {
                let word = word_at(&self.text(&uri), line, character);
                let refs: Vec<Value> = self
                    .files()
                    .iter()
                    .flat_map(|(file, text)| {
                        occurrences(text, &word)
                            .into_iter()
                            .map(move |(n, s, e)| json!({ "uri": file, "range": range(n, s, e) }))
                    })
                    .collect();
                Some(json!(refs))
            }
            "textDocument/prepareRename" => {
                let text = self.text(&uri);
                let word = word_at(&text, line, character);
                let hit = occurrences(&text, &word)
                    .into_iter()
                    .find(|(n, s, e)| *n == line && *s <= character && character <= *e);
                Some(hit.map_or(
                    Value::Null,
                    |(n, s, e)| json!({ "range": range(n, s, e), "placeholder": word }),
                ))
            }
            "textDocument/rename" => {
                let word = word_at(&self.text(&uri), line, character);
                let new_name = params["newName"].as_str().unwrap_or("");
                let changes: Vec<Value> = self
                    .files()
                    .iter()
                    .filter_map(|(file, text)| {
                        let edits: Vec<Value> = occurrences(text, &word)
                            .into_iter()
                            .map(|(n, s, e)| json!({ "range": range(n, s, e), "newText": new_name }))
                            .collect();
                        (!edits.is_empty()).then(|| {
                            json!({ "textDocument": { "uri": file, "version": null }, "edits": edits })
                        })
                    })
                    .collect();
                Some(json!({ "documentChanges": changes }))
            }
            "textDocument/formatting" => {
                let text = self.text(&uri);
                let edits: Vec<Value> = text
                    .split('\n')
                    .enumerate()
                    .filter_map(|(n, l)| {
                        let trimmed = l.trim_end_matches([' ', '\t']);
                        (trimmed.len() != l.len()).then(|| {
                            json!({ "range": range(n, utf16(trimmed), utf16(l)), "newText": "" })
                        })
                    })
                    .collect();
                Some(json!(edits))
            }
            "textDocument/documentSymbol" => {
                let text = self.text(&uri);
                let symbols: Vec<Value> = text
                    .split('\n')
                    .enumerate()
                    .filter_map(|(n, l)| {
                        let (name, start) = definition(l)?;
                        Some(json!({ "name": name, "kind": 12, "range": range(n, 0, utf16(l)), "selectionRange": range(n, start, start + utf16(name)) }))
                    })
                    .collect();
                Some(json!(symbols))
            }
            "workspace/symbol" => {
                let query = params["query"].as_str().unwrap_or("").to_lowercase();
                let mut found = Vec::new();
                for (file, text) in self.files() {
                    for (n, l) in text.split('\n').enumerate() {
                        if let Some((name, start)) = definition(l)
                            && name.to_lowercase().contains(&query)
                        {
                            found.push(json!({ "name": name, "kind": 12, "location": { "uri": file, "range": range(n, start, start + utf16(name)) } }));
                        }
                    }
                }
                Some(json!(found))
            }
            "textDocument/codeAction" => {
                let actions: Vec<Value> = params["context"]["diagnostics"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|d| d["message"].as_str().is_some_and(|m| m.starts_with("FIXME")))
                    .map(|d| {
                        json!({
                            "title": "Mark as done",
                            "kind": "quickfix",
                            "diagnostics": [d],
                            "isPreferred": true,
                            "edit": { "changes": { uri.clone(): [{ "range": d["range"], "newText": "DONE" }] } }
                        })
                    })
                    .collect();
                Some(json!(actions))
            }
            "textDocument/documentHighlight" => {
                let text = self.text(&uri);
                let word = word_at(&text, line, character);
                let found: Vec<Value> = occurrences(&text, &word)
                    .into_iter()
                    .map(|(n, s, e)| json!({ "range": range(n, s, e), "kind": 1 }))
                    .collect();
                Some(json!(found))
            }
            "textDocument/signatureHelp" => Some(json!({
                "signatures": [{ "label": "call(first, second)", "parameters": [{ "label": "first" }, { "label": "second" }] }],
                "activeSignature": 0,
                "activeParameter": 0
            })),
            "textDocument/inlayHint" => {
                let text = self.text(&uri);
                let hints: Vec<Value> = text
                    .split('\n')
                    .enumerate()
                    .filter(|(_, l)| definition(l).is_some())
                    .map(|(n, l)| json!({ "position": { "line": n, "character": utf16(l) }, "label": ": fake", "paddingLeft": true }))
                    .collect();
                Some(json!(hints))
            }
            "shutdown" => Some(Value::Null),
            "exit" => std::process::exit(0),
            _ => {
                if message.get("id").is_some() {
                    write_message(
                        &json!({ "jsonrpc": "2.0", "id": message["id"], "error": { "code": -32601, "message": format!("{method} isn't supported") } }),
                    );
                }
                None
            }
        }
    }
}

fn main() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut server = Server {
        root: None,
        docs: BTreeMap::new(),
        next_id: 0,
    };
    while let Some(message) = read_message(&mut input) {
        // A response to our own request (the configuration).
        if message.get("method").is_none() {
            eprintln!("fake-lsp: config {}", message["result"]);
            continue;
        }
        let result = server.handle(&message);
        if let (Some(id), Some(result)) = (message.get("id"), result) {
            write_message(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        }
    }
}
