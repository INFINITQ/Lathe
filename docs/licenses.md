# Third-party licenses

Made by `node tools/license-report.mjs` on 2026-11-03. It lists what Lathe ships:
161 npm packages its UI installs for production (most are bundled into the UI, some only in part) and
293 Rust crates compiled into lathe.exe. Build tools and test-only packages are left out.

Language servers, debug adapters and Jupyter kernels are not shipped. Lathe downloads the ones you
ask for (each pinned to a version and checked against a SHA-256) into its own folder, or uses the
ones you have installed; each comes with its own license. Plugins you install are likewise their
authors' own.

## Summary

| License                                             | npm | Rust |
| --------------------------------------------------- | --: | ---: |
| MIT                                                 | 156 |   46 |
| MIT OR Apache-2.0                                   |   0 |  145 |
| Apache-2.0 OR MIT                                   |   1 |   30 |
| Unicode-3.0                                         |   0 |   18 |
| Unlicense OR MIT                                    |   0 |   13 |
| MPL-2.0                                             |   0 |    6 |
| BSD-3-Clause                                        |   0 |    5 |
| MIT/Apache-2.0                                      |   0 |    5 |
| Apache-2.0                                          |   0 |    5 |
| OFL-1.1                                             |   2 |    0 |
| ISC                                                 |   1 |    1 |
| Zlib                                                |   0 |    2 |
| MIT OR Zlib OR Apache-2.0                           |   0 |    2 |
| Unlicense/MIT                                       |   0 |    2 |
| 0BSD                                                |   1 |    0 |
| 0BSD OR MIT OR Apache-2.0                           |   0 |    1 |
| BSD-3-Clause AND MIT                                |   0 |    1 |
| BSD-3-Clause/MIT                                    |   0 |    1 |
| Apache-2.0 AND MIT                                  |   0 |    1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0                      |   0 |    1 |
| (Apache-2.0 OR MIT) AND BSD-3-Clause                |   0 |    1 |
| Apache-2.0 / MIT                                    |   0 |    1 |
| CC0-1.0                                             |   0 |    1 |
| MIT OR Apache-2.0 OR Zlib                           |   0 |    1 |
| Apache-2.0 AND ISC                                  |   0 |    1 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |   0 |    1 |
| Zlib OR Apache-2.0 OR MIT                           |   0 |    1 |
| (MIT OR Apache-2.0) AND Unicode-3.0                 |   0 |    1 |

## Copyleft

These ask that changes to them be shared when the app is given to others (personal use is unaffected):

- cssparser 0.37.0: MPL-2.0
- cssparser-macros 0.7.1: MPL-2.0
- dtoa-short 0.3.5: MPL-2.0
- nucleo-matcher 0.3.1: MPL-2.0
- option-ext 0.2.0: MPL-2.0
- selectors 0.38.0: MPL-2.0

## npm packages

| Package                                 | Version | License           |
| --------------------------------------- | ------- | ----------------- |
| @codemirror/autocomplete                | 6.20.4  | MIT               |
| @codemirror/commands                    | 6.11.1  | MIT               |
| @codemirror/lang-angular                | 0.1.4   | MIT               |
| @codemirror/lang-cpp                    | 6.0.3   | MIT               |
| @codemirror/lang-css                    | 6.3.1   | MIT               |
| @codemirror/lang-go                     | 6.0.1   | MIT               |
| @codemirror/lang-html                   | 6.4.12  | MIT               |
| @codemirror/lang-java                   | 6.0.2   | MIT               |
| @codemirror/lang-javascript             | 6.2.5   | MIT               |
| @codemirror/lang-jinja                  | 6.0.1   | MIT               |
| @codemirror/lang-json                   | 6.0.2   | MIT               |
| @codemirror/lang-less                   | 6.0.2   | MIT               |
| @codemirror/lang-liquid                 | 6.3.3   | MIT               |
| @codemirror/lang-markdown               | 6.5.2   | MIT               |
| @codemirror/lang-php                    | 6.0.2   | MIT               |
| @codemirror/lang-python                 | 6.2.1   | MIT               |
| @codemirror/lang-rust                   | 6.0.2   | MIT               |
| @codemirror/lang-sass                   | 6.0.2   | MIT               |
| @codemirror/lang-sql                    | 6.10.0  | MIT               |
| @codemirror/lang-vue                    | 0.1.3   | MIT               |
| @codemirror/lang-wast                   | 6.0.2   | MIT               |
| @codemirror/lang-xml                    | 6.1.0   | MIT               |
| @codemirror/lang-yaml                   | 6.1.3   | MIT               |
| @codemirror/language                    | 6.13.1  | MIT               |
| @codemirror/language-data               | 6.5.2   | MIT               |
| @codemirror/legacy-modes                | 6.5.5   | MIT               |
| @codemirror/lint                        | 6.9.7   | MIT               |
| @codemirror/lsp-client                  | 6.3.0   | MIT               |
| @codemirror/merge                       | 6.12.3  | MIT               |
| @codemirror/search                      | 6.7.2   | MIT               |
| @codemirror/state                       | 6.7.6   | MIT               |
| @codemirror/streamparser                | 6.0.0   | MIT               |
| @codemirror/view                        | 6.43.15 | MIT               |
| @emmetio/abbreviation                   | 2.3.3   | MIT               |
| @emmetio/codemirror6-plugin             | 0.4.2   | MIT               |
| @emmetio/css-abbreviation               | 2.1.8   | MIT               |
| @emmetio/math-expression                | 1.0.5   | MIT               |
| @emmetio/scanner                        | 1.0.4   | MIT               |
| @floating-ui/core                       | 1.8.0   | MIT               |
| @floating-ui/dom                        | 1.8.0   | MIT               |
| @floating-ui/react-dom                  | 2.1.9   | MIT               |
| @floating-ui/utils                      | 0.2.12  | MIT               |
| @fontsource-variable/inter              | 5.3.0   | OFL-1.1           |
| @fontsource-variable/jetbrains-mono     | 5.3.0   | OFL-1.1           |
| @lezer/common                           | 1.5.5   | MIT               |
| @lezer/cpp                              | 1.1.6   | MIT               |
| @lezer/css                              | 1.3.9   | MIT               |
| @lezer/go                               | 1.0.1   | MIT               |
| @lezer/highlight                        | 1.2.5   | MIT               |
| @lezer/html                             | 1.3.13  | MIT               |
| @lezer/java                             | 1.1.5   | MIT               |
| @lezer/javascript                       | 1.5.6   | MIT               |
| @lezer/json                             | 1.0.3   | MIT               |
| @lezer/lr                               | 1.4.12  | MIT               |
| @lezer/markdown                         | 1.8.1   | MIT               |
| @lezer/php                              | 1.0.6   | MIT               |
| @lezer/python                           | 1.1.19  | MIT               |
| @lezer/rust                             | 1.0.3   | MIT               |
| @lezer/sass                             | 1.1.0   | MIT               |
| @lezer/xml                              | 1.0.6   | MIT               |
| @lezer/yaml                             | 1.0.4   | MIT               |
| @marijn/find-cluster-break              | 1.0.4   | MIT               |
| @radix-ui/number                        | 1.1.3   | MIT               |
| @radix-ui/primitive                     | 1.2.0   | MIT               |
| @radix-ui/react-accessible-icon         | 1.2.0   | MIT               |
| @radix-ui/react-accordion               | 1.3.1   | MIT               |
| @radix-ui/react-alert-dialog            | 1.2.1   | MIT               |
| @radix-ui/react-arrow                   | 1.1.17  | MIT               |
| @radix-ui/react-aspect-ratio            | 1.2.0   | MIT               |
| @radix-ui/react-avatar                  | 1.3.1   | MIT               |
| @radix-ui/react-checkbox                | 1.4.1   | MIT               |
| @radix-ui/react-collapsible             | 1.2.1   | MIT               |
| @radix-ui/react-collection              | 1.2.0   | MIT               |
| @radix-ui/react-compose-refs            | 1.1.5   | MIT               |
| @radix-ui/react-context                 | 1.3.0   | MIT               |
| @radix-ui/react-context-menu            | 2.4.1   | MIT               |
| @radix-ui/react-dialog                  | 1.3.1   | MIT               |
| @radix-ui/react-direction               | 1.2.0   | MIT               |
| @radix-ui/react-dismissable-layer       | 1.2.1   | MIT               |
| @radix-ui/react-dropdown-menu           | 2.2.1   | MIT               |
| @radix-ui/react-focus-guards            | 1.2.0   | MIT               |
| @radix-ui/react-focus-scope             | 1.3.1   | MIT               |
| @radix-ui/react-form                    | 0.3.0   | MIT               |
| @radix-ui/react-hover-card              | 1.2.1   | MIT               |
| @radix-ui/react-id                      | 1.1.4   | MIT               |
| @radix-ui/react-label                   | 2.1.17  | MIT               |
| @radix-ui/react-menu                    | 2.2.1   | MIT               |
| @radix-ui/react-menubar                 | 1.2.1   | MIT               |
| @radix-ui/react-navigation-menu         | 1.4.1   | MIT               |
| @radix-ui/react-one-time-password-field | 0.2.1   | MIT               |
| @radix-ui/react-password-toggle-field   | 0.2.1   | MIT               |
| @radix-ui/react-popover                 | 1.3.1   | MIT               |
| @radix-ui/react-popper                  | 1.4.0   | MIT               |
| @radix-ui/react-portal                  | 1.2.0   | MIT               |
| @radix-ui/react-presence                | 1.1.11  | MIT               |
| @radix-ui/react-primitive               | 2.2.0   | MIT               |
| @radix-ui/react-progress                | 1.2.1   | MIT               |
| @radix-ui/react-radio-group             | 1.5.1   | MIT               |
| @radix-ui/react-roving-focus            | 1.2.1   | MIT               |
| @radix-ui/react-scroll-area             | 1.4.0   | MIT               |
| @radix-ui/react-select                  | 2.4.1   | MIT               |
| @radix-ui/react-separator               | 1.2.0   | MIT               |
| @radix-ui/react-slider                  | 1.6.1   | MIT               |
| @radix-ui/react-slot                    | 1.5.0   | MIT               |
| @radix-ui/react-switch                  | 1.4.1   | MIT               |
| @radix-ui/react-tabs                    | 1.2.1   | MIT               |
| @radix-ui/react-toast                   | 1.3.1   | MIT               |
| @radix-ui/react-toggle                  | 1.2.1   | MIT               |
| @radix-ui/react-toggle-group            | 1.2.1   | MIT               |
| @radix-ui/react-toolbar                 | 1.2.1   | MIT               |
| @radix-ui/react-tooltip                 | 1.4.1   | MIT               |
| @radix-ui/react-use-callback-ref        | 1.1.5   | MIT               |
| @radix-ui/react-use-controllable-state  | 1.3.0   | MIT               |
| @radix-ui/react-use-effect-event        | 0.0.5   | MIT               |
| @radix-ui/react-use-escape-keydown      | 1.1.6   | MIT               |
| @radix-ui/react-use-is-hydrated         | 0.1.3   | MIT               |
| @radix-ui/react-use-layout-effect       | 1.1.4   | MIT               |
| @radix-ui/react-use-previous            | 1.1.4   | MIT               |
| @radix-ui/react-use-rect                | 1.1.4   | MIT               |
| @radix-ui/react-use-size                | 1.1.5   | MIT               |
| @radix-ui/react-visually-hidden         | 1.2.13  | MIT               |
| @radix-ui/rect                          | 1.1.3   | MIT               |
| @replit/codemirror-indentation-markers  | 6.5.3   | MIT               |
| @replit/codemirror-vim                  | 6.4.0   | MIT               |
| @replit/codemirror-vim-core             | 0.1.0   | MIT               |
| @tanstack/react-virtual                 | 3.14.24 | MIT               |
| @tanstack/virtual-core                  | 3.19.9  | MIT               |
| @tauri-apps/api                         | 2.12.4  | Apache-2.0 OR MIT |
| @types/react                            | 19.3.0  | MIT               |
| @types/react-dom                        | 19.3.0  | MIT               |
| @xterm/addon-fit                        | 0.11.0  | MIT               |
| @xterm/addon-search                     | 0.16.0  | MIT               |
| @xterm/addon-unicode11                  | 0.9.0   | MIT               |
| @xterm/addon-web-links                  | 0.12.0  | MIT               |
| @xterm/xterm                            | 6.0.0   | MIT               |
| aria-hidden                             | 1.2.6   | MIT               |
| clsx                                    | 2.1.1   | MIT               |
| crelt                                   | 1.0.7   | MIT               |
| csstype                                 | 3.2.3   | MIT               |
| detect-node-es                          | 1.1.0   | MIT               |
| emmet                                   | 2.4.11  | MIT               |
| get-nonce                               | 1.0.1   | MIT               |
| lucide-react                            | 1.65.0  | ISC               |
| marked                                  | 15.0.12 | MIT               |
| radix-ui                                | 1.8.1   | MIT               |
| react                                   | 19.3.1  | MIT               |
| react-dom                               | 19.3.1  | MIT               |
| react-remove-scroll                     | 2.7.2   | MIT               |
| react-remove-scroll-bar                 | 2.3.8   | MIT               |
| react-style-singleton                   | 2.2.3   | MIT               |
| scheduler                               | 0.28.0  | MIT               |
| style-mod                               | 4.1.4   | MIT               |
| tailwind-merge                          | 3.7.0   | MIT               |
| tslib                                   | 2.9.1   | 0BSD              |
| use-callback-ref                        | 1.3.3   | MIT               |
| use-sidecar                             | 1.1.3   | MIT               |
| vscode-jsonrpc                          | 10.0.0  | MIT               |
| vscode-languageserver-protocol          | 3.18.5  | MIT               |
| vscode-languageserver-types             | 3.18.5  | MIT               |
| w3c-keyname                             | 2.2.8   | MIT               |
| zustand                                 | 5.0.16  | MIT               |

## Rust crates

| Crate                        | Version          | License                                             |
| ---------------------------- | ---------------- | --------------------------------------------------- |
| adler2                       | 2.0.1            | 0BSD OR MIT OR Apache-2.0                           |
| aho-corasick                 | 1.1.5            | Unlicense OR MIT                                    |
| alloc-no-stdlib              | 3.0.0            | BSD-3-Clause                                        |
| alloc-stdlib                 | 0.3.0            | BSD-3-Clause                                        |
| anyhow                       | 1.0.104          | MIT OR Apache-2.0                                   |
| async-io                     | 2.6.0            | Apache-2.0 OR MIT                                   |
| async-trait                  | 0.1.92           | MIT OR Apache-2.0                                   |
| asynchronous-codec           | 0.7.0            | MIT                                                 |
| base64                       | 0.23.1           | MIT OR Apache-2.0                                   |
| bit-set                      | 0.8.0            | Apache-2.0 OR MIT                                   |
| bit-vec                      | 0.8.0            | Apache-2.0 OR MIT                                   |
| bitflags                     | 1.3.2            | MIT/Apache-2.0                                      |
| bitflags                     | 2.13.2           | MIT OR Apache-2.0                                   |
| block-buffer                 | 0.10.4           | MIT OR Apache-2.0                                   |
| brotli                       | 9.1.1            | BSD-3-Clause AND MIT                                |
| brotli-decompressor          | 6.2.0            | BSD-3-Clause/MIT                                    |
| bs58                         | 0.5.1            | MIT/Apache-2.0                                      |
| bstr                         | 1.13.1           | MIT OR Apache-2.0                                   |
| byteorder                    | 1.5.0            | Unlicense OR MIT                                    |
| bytes                        | 1.12.1           | MIT                                                 |
| camino                       | 1.2.6            | MIT OR Apache-2.0                                   |
| cargo_metadata               | 0.19.2           | MIT                                                 |
| cargo-platform               | 0.1.9            | MIT OR Apache-2.0                                   |
| cfb                          | 0.14.0           | MIT                                                 |
| cfg-if                       | 1.0.5            | MIT OR Apache-2.0                                   |
| chacha20                     | 0.10.2           | MIT OR Apache-2.0                                   |
| chardetng                    | 1.0.0            | Apache-2.0 OR MIT                                   |
| chrono                       | 0.4.45           | MIT OR Apache-2.0                                   |
| concurrent-queue             | 2.5.0            | Apache-2.0 OR MIT                                   |
| cookie                       | 0.18.2           | MIT OR Apache-2.0                                   |
| core_detect                  | 1.0.0            | MIT/Apache-2.0                                      |
| cpufeatures                  | 0.2.17           | MIT OR Apache-2.0                                   |
| cpufeatures                  | 0.3.1            | MIT OR Apache-2.0                                   |
| crc32fast                    | 1.5.4            | MIT OR Apache-2.0                                   |
| crossbeam-channel            | 0.5.17           | MIT OR Apache-2.0                                   |
| crossbeam-deque              | 0.8.8            | MIT OR Apache-2.0                                   |
| crossbeam-epoch              | 0.9.21           | MIT OR Apache-2.0                                   |
| crossbeam-queue              | 0.3.14           | MIT OR Apache-2.0                                   |
| crossbeam-utils              | 0.8.23           | MIT OR Apache-2.0                                   |
| crypto-common                | 0.1.7            | MIT OR Apache-2.0                                   |
| cssparser                    | 0.37.0           | MPL-2.0                                             |
| cssparser-macros             | 0.7.1            | MPL-2.0                                             |
| ctor                         | 1.0.13           | Apache-2.0 OR MIT                                   |
| darling                      | 0.24.1           | MIT                                                 |
| darling_core                 | 0.24.1           | MIT                                                 |
| darling_macro                | 0.24.1           | MIT                                                 |
| data-encoding                | 2.11.1           | MIT                                                 |
| defmt                        | 1.2.0            | MIT OR Apache-2.0                                   |
| defmt-macros                 | 1.2.0            | MIT OR Apache-2.0                                   |
| defmt-parser                 | 1.1.0            | MIT OR Apache-2.0                                   |
| deranged                     | 0.5.9            | MIT OR Apache-2.0                                   |
| derive_more                  | 2.1.1            | MIT                                                 |
| derive_more-impl             | 2.1.1            | MIT                                                 |
| digest                       | 0.10.7           | MIT OR Apache-2.0                                   |
| dirs                         | 6.0.0            | MIT OR Apache-2.0                                   |
| dirs                         | 7.0.0            | MIT OR Apache-2.0                                   |
| dirs-sys                     | 0.5.0            | MIT OR Apache-2.0                                   |
| displaydoc                   | 0.2.7            | MIT OR Apache-2.0                                   |
| dom_query                    | 0.28.0           | MIT                                                 |
| dpi                          | 0.1.2            | Apache-2.0 AND MIT                                  |
| dtoa                         | 1.0.11           | MIT OR Apache-2.0                                   |
| dtoa-short                   | 0.3.5            | MPL-2.0                                             |
| dunce                        | 1.0.5            | CC0-1.0 OR MIT-0 OR Apache-2.0                      |
| dyn-clone                    | 1.0.20           | MIT OR Apache-2.0                                   |
| encoding_rs                  | 0.8.44           | (Apache-2.0 OR MIT) AND BSD-3-Clause                |
| encoding_rs_io               | 0.1.8            | MIT OR Apache-2.0                                   |
| equivalent                   | 1.0.3            | Apache-2.0 OR MIT                                   |
| erased-serde                 | 0.4.11           | MIT OR Apache-2.0                                   |
| errno                        | 0.3.14           | MIT OR Apache-2.0                                   |
| fastrand                     | 2.5.0            | Apache-2.0 OR MIT                                   |
| fdeflate                     | 0.3.7            | MIT OR Apache-2.0                                   |
| file-id                      | 0.2.3            | MIT OR Apache-2.0                                   |
| flate2                       | 1.1.10           | MIT OR Apache-2.0                                   |
| fnv                          | 1.0.7            | Apache-2.0 / MIT                                    |
| foldhash                     | 0.2.0            | Zlib                                                |
| form_urlencoded              | 1.2.2            | MIT OR Apache-2.0                                   |
| futures                      | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-channel              | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-core                 | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-executor             | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-io                   | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-lite                 | 2.6.1            | Apache-2.0 OR MIT                                   |
| futures-macro                | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-sink                 | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-task                 | 0.3.34           | MIT OR Apache-2.0                                   |
| futures-util                 | 0.3.34           | MIT OR Apache-2.0                                   |
| generic-array                | 0.14.7           | MIT                                                 |
| getrandom                    | 0.2.17           | MIT OR Apache-2.0                                   |
| getrandom                    | 0.3.4            | MIT OR Apache-2.0                                   |
| getrandom                    | 0.4.3            | MIT OR Apache-2.0                                   |
| glob                         | 0.3.4            | MIT OR Apache-2.0                                   |
| globset                      | 0.4.21           | Unlicense OR MIT                                    |
| grep-matcher                 | 0.1.9            | Unlicense OR MIT                                    |
| grep-regex                   | 0.1.14           | Unlicense OR MIT                                    |
| grep-searcher                | 0.1.17           | Unlicense OR MIT                                    |
| hashbrown                    | 0.12.3           | MIT OR Apache-2.0                                   |
| hashbrown                    | 0.17.1           | MIT OR Apache-2.0                                   |
| heck                         | 0.5.0            | MIT OR Apache-2.0                                   |
| hex                          | 0.4.3            | MIT OR Apache-2.0                                   |
| html5ever                    | 0.39.0           | MIT OR Apache-2.0                                   |
| http                         | 1.5.0            | MIT OR Apache-2.0                                   |
| ico                          | 0.6.0            | MIT                                                 |
| icu_collections              | 2.4.0            | Unicode-3.0                                         |
| icu_locale_core              | 2.4.0            | Unicode-3.0                                         |
| icu_normalizer               | 2.4.0            | Unicode-3.0                                         |
| icu_normalizer_data          | 2.4.0            | Unicode-3.0                                         |
| icu_properties               | 2.4.0            | Unicode-3.0                                         |
| icu_properties_data          | 2.4.0            | Unicode-3.0                                         |
| icu_provider                 | 2.4.0            | Unicode-3.0                                         |
| ident_case                   | 1.0.1            | MIT/Apache-2.0                                      |
| idna                         | 1.1.0            | MIT OR Apache-2.0                                   |
| idna_adapter                 | 1.2.2            | Apache-2.0 OR MIT                                   |
| ignore                       | 0.4.34           | Unlicense OR MIT                                    |
| indexmap                     | 1.9.3            | Apache-2.0 OR MIT                                   |
| indexmap                     | 2.14.2           | Apache-2.0 OR MIT                                   |
| infer                        | 0.22.0           | MIT                                                 |
| itoa                         | 1.0.18           | MIT OR Apache-2.0                                   |
| jiff                         | 0.2.39           | Unlicense OR MIT                                    |
| jiff-core                    | 0.1.2            | Unlicense OR MIT                                    |
| jiff-tzdb                    | 0.1.9            | Unlicense OR MIT                                    |
| jiff-tzdb-platform           | 0.1.3            | Unlicense OR MIT                                    |
| json-patch                   | 4.2.0            | MIT/Apache-2.0                                      |
| jsonptr                      | 0.7.1            | MIT OR Apache-2.0                                   |
| jupyter-protocol             | 2.0.3            | BSD-3-Clause                                        |
| jupyter-zmq-client           | 3.0.1            | BSD-3-Clause                                        |
| keyboard-types               | 0.8.3            | MIT OR Apache-2.0                                   |
| libc                         | 0.2.191          | MIT OR Apache-2.0                                   |
| litemap                      | 0.8.3            | Unicode-3.0                                         |
| lock_api                     | 0.4.14           | MIT OR Apache-2.0                                   |
| log                          | 0.4.35           | MIT OR Apache-2.0                                   |
| markup5ever                  | 0.39.0           | MIT OR Apache-2.0                                   |
| memchr                       | 2.8.3            | Unlicense OR MIT                                    |
| memmap2                      | 0.9.12           | MIT OR Apache-2.0                                   |
| mime                         | 0.3.17           | MIT OR Apache-2.0                                   |
| miniz_oxide                  | 0.8.9            | MIT OR Zlib OR Apache-2.0                           |
| miniz_oxide                  | 0.9.1            | MIT OR Zlib OR Apache-2.0                           |
| mio                          | 1.2.4            | MIT                                                 |
| muda                         | 0.20.0           | Apache-2.0 OR MIT                                   |
| multiversion_no_op           | 1.0.0            | Apache-2.0 OR MIT                                   |
| new_debug_unreachable        | 1.0.6            | MIT                                                 |
| notify                       | 8.2.1            | CC0-1.0                                             |
| notify-debouncer-full        | 0.7.0            | MIT OR Apache-2.0                                   |
| notify-types                 | 2.2.0            | MIT OR Apache-2.0                                   |
| nucleo-matcher               | 0.3.1            | MPL-2.0                                             |
| num-conv                     | 0.2.2            | MIT OR Apache-2.0                                   |
| num-traits                   | 0.2.19           | MIT OR Apache-2.0                                   |
| once_cell                    | 1.21.4           | MIT OR Apache-2.0                                   |
| option-ext                   | 0.2.0            | MPL-2.0                                             |
| parking                      | 2.2.1            | Apache-2.0 OR MIT                                   |
| parking_lot                  | 0.12.5           | MIT OR Apache-2.0                                   |
| parking_lot_core             | 0.9.12           | MIT OR Apache-2.0                                   |
| percent-encoding             | 2.3.2            | MIT OR Apache-2.0                                   |
| phf                          | 0.13.1           | MIT                                                 |
| phf_generator                | 0.13.1           | MIT                                                 |
| phf_macros                   | 0.13.1           | MIT                                                 |
| phf_shared                   | 0.13.1           | MIT                                                 |
| pin-project-lite             | 0.2.17           | Apache-2.0 OR MIT                                   |
| plist                        | 1.10.3           | MIT                                                 |
| png                          | 0.18.1           | MIT OR Apache-2.0                                   |
| polling                      | 3.11.0           | Apache-2.0 OR MIT                                   |
| potential_utf                | 0.1.6            | Unicode-3.0                                         |
| powerfmt                     | 0.2.1            | MIT OR Apache-2.0                                   |
| precomputed-hash             | 0.1.1            | MIT                                                 |
| proc-macro2                  | 1.0.107          | MIT OR Apache-2.0                                   |
| quick-xml                    | 0.42.0           | MIT                                                 |
| quote                        | 1.0.47           | MIT OR Apache-2.0                                   |
| rand                         | 0.10.3           | MIT OR Apache-2.0                                   |
| rand_core                    | 0.10.1           | MIT OR Apache-2.0                                   |
| raw-window-handle            | 0.6.2            | MIT OR Apache-2.0 OR Zlib                           |
| ref-cast                     | 1.0.27           | MIT OR Apache-2.0                                   |
| ref-cast-impl                | 1.0.27           | MIT OR Apache-2.0                                   |
| regex                        | 1.13.1           | MIT OR Apache-2.0                                   |
| regex-automata               | 0.4.18           | MIT OR Apache-2.0                                   |
| regex-syntax                 | 0.8.11           | MIT OR Apache-2.0                                   |
| rfd                          | 0.17.2           | MIT                                                 |
| ring                         | 0.17.14          | Apache-2.0 AND ISC                                  |
| rustc-hash                   | 2.1.3            | Apache-2.0 OR MIT                                   |
| rustix                       | 1.1.6            | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| saa                          | 5.6.2            | Apache-2.0                                          |
| same-file                    | 1.0.6            | Unlicense/MIT                                       |
| scc                          | 3.8.8            | Apache-2.0                                          |
| schemars                     | 0.8.22           | MIT                                                 |
| schemars                     | 0.9.0            | MIT                                                 |
| schemars                     | 1.2.3            | MIT                                                 |
| schemars_derive              | 0.8.22           | MIT                                                 |
| scopeguard                   | 1.2.0            | MIT OR Apache-2.0                                   |
| sdd                          | 4.8.11           | Apache-2.0                                          |
| selectors                    | 0.38.0           | MPL-2.0                                             |
| semver                       | 1.0.28           | MIT OR Apache-2.0                                   |
| serde                        | 1.0.229          | MIT OR Apache-2.0                                   |
| serde_core                   | 1.0.229          | MIT OR Apache-2.0                                   |
| serde_derive                 | 1.0.229          | MIT OR Apache-2.0                                   |
| serde_derive_internals       | 0.29.1           | MIT OR Apache-2.0                                   |
| serde_json                   | 1.0.154          | MIT OR Apache-2.0                                   |
| serde_repr                   | 0.1.21           | MIT OR Apache-2.0                                   |
| serde_spanned                | 1.1.2            | MIT OR Apache-2.0                                   |
| serde_with                   | 3.24.0           | MIT OR Apache-2.0                                   |
| serde_with_macros            | 3.24.0           | MIT OR Apache-2.0                                   |
| serde-untagged               | 0.1.9            | MIT OR Apache-2.0                                   |
| serialize-to-javascript      | 0.1.2            | MIT OR Apache-2.0                                   |
| serialize-to-javascript-impl | 0.1.2            | MIT OR Apache-2.0                                   |
| servo_arc                    | 0.4.3            | MIT OR Apache-2.0                                   |
| sha1_smol                    | 1.0.1            | BSD-3-Clause                                        |
| sha2                         | 0.10.9           | MIT OR Apache-2.0                                   |
| simd-adler32                 | 0.3.10           | MIT                                                 |
| simdutf8                     | 0.1.5            | MIT OR Apache-2.0                                   |
| similar                      | 3.2.1            | Apache-2.0                                          |
| siphasher                    | 1.0.4            | MIT OR Apache-2.0                                   |
| slab                         | 0.4.12           | MIT                                                 |
| smallvec                     | 1.16.4           | MIT OR Apache-2.0                                   |
| socket2                      | 0.6.5            | MIT OR Apache-2.0                                   |
| softbuffer                   | 0.4.8            | MIT OR Apache-2.0                                   |
| stable_deref_trait           | 1.2.1            | MIT OR Apache-2.0                                   |
| string_cache                 | 0.9.0            | MIT OR Apache-2.0                                   |
| strsim                       | 0.11.1           | MIT                                                 |
| syn                          | 2.0.119          | MIT OR Apache-2.0                                   |
| syn                          | 3.0.9            | MIT OR Apache-2.0                                   |
| synstructure                 | 0.14.0           | MIT                                                 |
| tao                          | 0.37.2           | Apache-2.0                                          |
| tauri                        | 2.12.5           | Apache-2.0 OR MIT                                   |
| tauri-codegen                | 2.7.4            | Apache-2.0 OR MIT                                   |
| tauri-macros                 | 2.7.4            | Apache-2.0 OR MIT                                   |
| tauri-plugin-single-instance | 2.5.5            | Apache-2.0 OR MIT                                   |
| tauri-runtime                | 2.12.2           | Apache-2.0 OR MIT                                   |
| tauri-runtime-wry            | 2.12.3           | Apache-2.0 OR MIT                                   |
| tauri-utils                  | 2.10.2           | Apache-2.0 OR MIT                                   |
| tendril                      | 0.5.1            | MIT OR Apache-2.0                                   |
| thiserror                    | 2.0.21           | MIT OR Apache-2.0                                   |
| thiserror-impl               | 2.0.21           | MIT OR Apache-2.0                                   |
| time                         | 0.3.55           | MIT OR Apache-2.0                                   |
| time-core                    | 0.1.9            | MIT OR Apache-2.0                                   |
| time-macros                  | 0.2.32           | MIT OR Apache-2.0                                   |
| tinystr                      | 0.8.5            | Unicode-3.0                                         |
| tinyvec                      | 1.13.3           | Zlib OR Apache-2.0 OR MIT                           |
| tokio                        | 1.54.1           | MIT                                                 |
| tokio-macros                 | 2.7.2            | MIT                                                 |
| tokio-util                   | 0.7.20           | MIT                                                 |
| toml                         | 1.1.8+spec-1.1.0 | MIT OR Apache-2.0                                   |
| toml_datetime                | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0                                   |
| toml_parser                  | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0                                   |
| toml_writer                  | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0                                   |
| tracing                      | 0.1.44           | MIT                                                 |
| tracing-attributes           | 0.1.31           | MIT                                                 |
| tracing-core                 | 0.1.36           | MIT                                                 |
| trash                        | 5.2.9            | MIT                                                 |
| tray-icon                    | 0.25.1           | MIT OR Apache-2.0                                   |
| typeid                       | 1.0.3            | MIT OR Apache-2.0                                   |
| typenum                      | 1.20.1           | MIT OR Apache-2.0                                   |
| unicode-ident                | 1.0.27           | (MIT OR Apache-2.0) AND Unicode-3.0                 |
| unicode-segmentation         | 1.13.3           | MIT OR Apache-2.0                                   |
| untrusted                    | 0.9.0            | ISC                                                 |
| url                          | 2.5.8            | MIT OR Apache-2.0                                   |
| urlpattern                   | 0.6.0            | MIT                                                 |
| utf_types                    | 1.0.0            | Apache-2.0 OR MIT                                   |
| utf8_iter                    | 1.1.0            | Apache-2.0 OR MIT                                   |
| uuid                         | 1.29.0           | Apache-2.0 OR MIT                                   |
| walkdir                      | 2.5.0            | Unlicense/MIT                                       |
| web_atoms                    | 0.2.6            | MIT OR Apache-2.0                                   |
| web-time                     | 1.1.0            | MIT OR Apache-2.0                                   |
| webview2-com                 | 0.39.1           | MIT                                                 |
| webview2-com-macros          | 0.8.1            | MIT                                                 |
| webview2-com-sys             | 0.39.1           | MIT                                                 |
| winapi-util                  | 0.1.11           | Unlicense OR MIT                                    |
| window-vibrancy              | 0.8.1            | Apache-2.0 OR MIT                                   |
| windows                      | 0.62.2           | MIT OR Apache-2.0                                   |
| windows_x86_64_msvc          | 0.53.1           | MIT OR Apache-2.0                                   |
| windows-collections          | 0.3.2            | MIT OR Apache-2.0                                   |
| windows-core                 | 0.62.2           | MIT OR Apache-2.0                                   |
| windows-future               | 0.3.2            | MIT OR Apache-2.0                                   |
| windows-implement            | 0.60.2           | MIT OR Apache-2.0                                   |
| windows-interface            | 0.59.3           | MIT OR Apache-2.0                                   |
| windows-link                 | 0.2.1            | MIT OR Apache-2.0                                   |
| windows-numerics             | 0.3.1            | MIT OR Apache-2.0                                   |
| windows-result               | 0.4.1            | MIT OR Apache-2.0                                   |
| windows-strings              | 0.5.1            | MIT OR Apache-2.0                                   |
| windows-sys                  | 0.60.2           | MIT OR Apache-2.0                                   |
| windows-sys                  | 0.61.2           | MIT OR Apache-2.0                                   |
| windows-targets              | 0.53.5           | MIT OR Apache-2.0                                   |
| windows-threading            | 0.2.1            | MIT OR Apache-2.0                                   |
| windows-version              | 0.1.7            | MIT OR Apache-2.0                                   |
| winnow                       | 1.0.4            | MIT                                                 |
| writeable                    | 0.6.4            | Unicode-3.0                                         |
| wry                          | 0.57.1           | Apache-2.0 OR MIT                                   |
| yoke                         | 0.8.4            | Unicode-3.0                                         |
| yoke-derive                  | 0.8.4            | Unicode-3.0                                         |
| zerofrom                     | 0.1.8            | Unicode-3.0                                         |
| zerofrom-derive              | 0.1.8            | Unicode-3.0                                         |
| zeromq                       | 0.7.0            | MIT                                                 |
| zerotrie                     | 0.2.5            | Unicode-3.0                                         |
| zerovec                      | 0.11.9           | Unicode-3.0                                         |
| zerovec-derive               | 0.11.7           | Unicode-3.0                                         |
| zlib-rs                      | 0.6.8            | Zlib                                                |
| zmij                         | 1.0.23           | MIT                                                 |
