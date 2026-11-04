//! JSON with comments and trailing commas (JSONC): the format of Lathe's settings, keybindings,
//! tasks and launch files, as in VS Code.

use serde_json::Value;

/// Parses JSONC. Errors give the line and column, which stay accurate because comments are
/// replaced by spaces rather than removed.
pub fn parse(text: &str) -> Result<Value, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&strip(text)).map_err(|err| err.to_string())
}

/// Plain JSON for `text`: comments become spaces (keeping every line and column where it was)
/// and trailing commas are dropped.
pub fn strip(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.get(i + 1) {
                    out.push(next);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match (c, chars.get(i + 1)) {
            ('"', _) => {
                in_string = true;
                out.push(c);
                i += 1;
            }
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    out.push(if chars[i] == '\r' { '\r' } else { ' ' });
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                out.push_str("  ");
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    out.push(if chars[i] == '\n' || chars[i] == '\r' {
                        chars[i]
                    } else {
                        ' '
                    });
                    i += 1;
                }
                if i < chars.len() {
                    out.push_str("  ");
                    i += 2;
                }
            }
            (',', _) => {
                // A comma followed only by whitespace and a closing bracket is trailing: drop it.
                let mut lookahead = i + 1;
                while lookahead < chars.len() {
                    let d = chars[lookahead];
                    if d.is_whitespace() {
                        lookahead += 1;
                    } else if d == '/' && chars.get(lookahead + 1) == Some(&'/') {
                        while lookahead < chars.len() && chars[lookahead] != '\n' {
                            lookahead += 1;
                        }
                    } else if d == '/' && chars.get(lookahead + 1) == Some(&'*') {
                        lookahead += 2;
                        while lookahead < chars.len()
                            && !(chars[lookahead] == '*' && chars.get(lookahead + 1) == Some(&'/'))
                        {
                            lookahead += 1;
                        }
                        lookahead += 2;
                    } else {
                        break;
                    }
                }
                let trailing = matches!(chars.get(lookahead), Some('}' | ']'));
                out.push(if trailing { ' ' } else { ',' });
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Applies a JSON merge patch (RFC 7386): objects merge key by key, `null` removes a key, and
/// anything else replaces the value.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Default::default());
    }
    let Value::Object(target) = target else {
        unreachable!()
    };
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else {
            merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn comments_and_trailing_commas_are_allowed() {
        let text = r#"{
  // the font
  "editor.fontSize": 14, /* inline */
  "url": "http://example.com/*not a comment*/",
  "list": [1, 2, 3,],
  "escaped": "a \" // still a string",
}"#;
        assert_eq!(
            parse(text).unwrap(),
            json!({
                "editor.fontSize": 14,
                "url": "http://example.com/*not a comment*/",
                "list": [1, 2, 3],
                "escaped": "a \" // still a string",
            })
        );
    }

    #[test]
    fn errors_point_at_the_right_line() {
        let err = parse("{\n  // fine\n  \"a\": 1\n  \"b\": 2\n}").unwrap_err();
        assert!(err.contains("line 4"), "{err}");
    }

    #[test]
    fn empty_files_and_byte_order_marks_are_fine() {
        assert_eq!(parse("").unwrap(), json!({}));
        assert_eq!(parse("\u{feff}{\"a\": 1}").unwrap(), json!({"a": 1}));
    }

    #[test]
    fn merge_patch_follows_rfc_7386() {
        let mut target = json!({"a": 1, "nested": {"x": 1, "y": 2}, "gone": true});
        merge_patch(
            &mut target,
            &json!({"a": 2, "nested": {"y": null, "z": 3}, "gone": null}),
        );
        assert_eq!(target, json!({"a": 2, "nested": {"x": 1, "z": 3}}));
    }
}
