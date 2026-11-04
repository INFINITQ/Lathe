//! A fake Jupyter kernel for Lathe's tests: jupyter-zmq-client's TestKernel, started from a
//! connection file the way ipykernel is (`fake-kernel -f <file>`). A few inputs get canned
//! answers; anything else is echoed back as output:
//! - `print(1+1)` prints 2;
//! - `1 + 1` returns 2;
//! - `plot()` shows a small PNG chart;
//! - `html()` shows HTML whose script fills in its text;
//! - `fail()` raises an error with a coloured traceback.
//!
//! A shutdown request (also a restart) ends the process; Lathe starts it again.

use jupyter_protocol::{
    DisplayData, ErrorOutput, ExecuteResult, ExecutionCount, Media, MediaType, StreamContent,
};
use jupyter_zmq_client::{CannedResponse, TestKernel, TestKernelConfig};

const PLOT_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAYAAACeXX40AAABzElEQVR42u3dMXLDMAwEQL0iL07lKg/Ln+RWnceJxQOIvRm1EgHs0KiS47jk8fg5D5FUABQABUARAAVAEQAFwJX5/v06Xz0mBeBydDACWAYdjADeBm/VO2QgwDvAQAjgn5B0/o40ApgAASGAcQgQDgdYZfgQDgNY8eZxGw4BWHnQEG4OsMOAIdwUYLehQrgRwK7DhHADgN2HCGFjgLsMD8KGAHcbGoSNAO46LAibAdyxfgCLA5wwIAiLApw0GAiLAZy2H9kHCwGcOgwICwCcPgQIiwCc3BM9CAHUeAhjADUcwhhAe499UJP1R3NFn+w4ejWrof4+IITRRgIIIYD2wVH9O67NA9AtuBzgNQBCGO0ZgBBGewWgfTDaJwAhjPYHQAijfQHQPhjtCYAQRnsBIITRHgBoH4zWDyCE0boBhDBaL4D2wWitAEIYrRFACKO1AWgfjNYFIITRegCEMFoHgBBGzw8ghNFzAwhh9LwA1hjq2P+1ByCE0bMBCGH0TADaC6PnANBtGP02gBBG4QPYA+FdKFZ9B8CNIP4XyR3vBHAgwnfgfOIdAIJ4fvqJFwXgPIylCgFwBsayhwdQAJR56Dye1OMGFD/BIgBKJE/fWev/5culdgAAAABJRU5ErkJggg==";

fn config() -> TestKernelConfig {
    TestKernelConfig::default()
        .with_response(
            "print(1+1)",
            CannedResponse {
                outputs: vec![StreamContent::stdout("2\n").into()],
            },
        )
        .with_response(
            "1 + 1",
            CannedResponse {
                outputs: vec![
                    ExecuteResult {
                        execution_count: ExecutionCount::new(1),
                        data: Media::from(MediaType::Plain("2".into())),
                        metadata: Default::default(),
                        transient: None,
                    }
                    .into(),
                ],
            },
        )
        .with_response(
            "plot()",
            CannedResponse {
                outputs: vec![
                    DisplayData::new(Media::new(vec![
                        MediaType::Png(PLOT_PNG.into()),
                        MediaType::Plain("<Figure size 160x80 with 1 Axes>".into()),
                    ]))
                    .into(),
                ],
            },
        )
        .with_response(
            "html()",
            CannedResponse {
                outputs: vec![
                    DisplayData::new(Media::new(vec![
                        MediaType::Html(
                            "<div id=\"out\">waiting</div><script>document.getElementById('out').textContent = 'from a script';</script>"
                                .into(),
                        ),
                        MediaType::Plain("<IPython.core.display.HTML object>".into()),
                    ]))
                    .into(),
                ],
            },
        )
        .with_response(
            "fail()",
            CannedResponse {
                outputs: vec![
                    ErrorOutput {
                        ename: "ValueError".into(),
                        evalue: "it failed on purpose".into(),
                        traceback: vec![
                            "\u{1b}[31mTraceback (most recent call last):\u{1b}[0m".into(),
                            "  Cell \u{1b}[32mIn[1], line 1\u{1b}[0m".into(),
                            "\u{1b}[31mValueError\u{1b}[0m: it failed on purpose".into(),
                        ],
                    }
                    .into(),
                ],
            },
        )
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(file) = args
        .iter()
        .position(|a| a == "-f")
        .and_then(|i| args.get(i + 1))
    else {
        eprintln!("usage: fake-kernel -f <connection file>");
        std::process::exit(2);
    };
    let kernel = match TestKernel::start_from_file(file, config()).await {
        Ok(kernel) => kernel,
        Err(err) => {
            eprintln!("fake-kernel: {err}");
            std::process::exit(1);
        }
    };
    eprintln!("fake-kernel: ready");
    let _ = kernel.await;
}
