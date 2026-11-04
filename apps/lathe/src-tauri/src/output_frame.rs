//! Notebook HTML outputs (pandas tables, plotly charts) run on their own origin, `lathe-output`
//! (http://lathe-output.localhost on Windows), in an iframe sandboxed without
//! allow-same-origin: their scripts run, but can't reach Lathe's page or its commands. This
//! serves the one page that frame loads; the notebook posts each output's HTML into it.

use std::borrow::Cow;

use tauri::http::{Request, Response, header};

const FRAME: &str = include_str!("output_frame.html");

/// What outputs may do: inline and remote scripts (plotly loads from a CDN), styles, images and
/// fonts, and HTTPS fetches. No frames, forms or plugins.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http://lathe-output.localhost; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; frame-src 'none'; form-action 'none'; base-uri 'none'";

pub fn respond(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path();
    let response = if path == "/" || path == "/frame.html" {
        Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header("Content-Security-Policy", CSP)
            .header("X-Content-Type-Options", "nosniff")
            .body(Cow::Borrowed(FRAME.as_bytes()))
    } else {
        Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b""[..]))
    };
    response.unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..])))
}
