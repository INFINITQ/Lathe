//! Lathe's Tauri shell: creates the window and wires lathe-core to the UI.

// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("Lathe targets Windows 11 only.");

mod caption;
mod cli;
mod commands;
mod debug_commands;
mod error;
mod explorer;
mod fs_commands;
mod git_commands;
mod guard;
mod kernel_commands;
mod links;
mod lsp_commands;
mod output_frame;
mod plugin_commands;
mod search_commands;
mod session_commands;
mod state;
mod terminal_commands;
mod theme;
mod toolchain_commands;
mod webview2;
mod window;
mod workspace_commands;

use std::path::PathBuf;

use tauri::{Emitter, Manager};

pub use error::{Error, Result};

/// Sent when a second launch of Lathe (`lathe <path>`) hands its arguments to this one.
pub const OPEN_EVENT: &str = "lathe://open";

fn main() {
    // `lathe …` from a terminal (bin\lathe.cmd): hand the arguments over, maybe wait, and exit.
    if let Some(code) = cli::run_if_cli() {
        std::process::exit(code);
    }
    guard::scrub_webview2_environment();
    let context = tauri::generate_context!();
    guard::require_release_security(&context);

    let mut builder = tauri::Builder::default().manage(cli::Waits::default());
    // One copy of Lathe at a time: a second launch hands its arguments to the first one. A test
    // run has its own data folder and runs as its own instance, so it skips this.
    if guard::test_data_dir().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            window::focus_main(app);
            let launch = window::Launch {
                args: args.into_iter().skip(1).collect(),
                cwd,
            };
            app.state::<cli::Waits>().register(&launch.args);
            let _ = app.emit_to(window::MAIN, OPEN_EVENT, launch);
        }));
    }

    let result = builder
        // Notebook HTML outputs, sandboxed on their own origin (see output_frame.rs).
        .register_uri_scheme_protocol("lathe-output", |_ctx, request| {
            output_frame::respond(request)
        })
        // Plugins run on their own origin (see plugin_commands.rs).
        .register_uri_scheme_protocol("lathe-plugin", plugin_commands::respond)
        .invoke_handler(tauri::generate_handler![
            commands::app_ready,
            commands::system_info,
            commands::window_set_dark,
            commands::caption_maximize_rect,
            commands::open_link,
            commands::vscode_user_dir,
            cli::wait_release,
            fs_commands::fs_read_text,
            fs_commands::history_list,
            fs_commands::history_read,
            fs_commands::fs_write_text,
            fs_commands::fs_new_file_format,
            fs_commands::fs_read_bytes,
            fs_commands::fs_read_dir,
            fs_commands::fs_stat,
            fs_commands::fs_create_file,
            fs_commands::fs_create_dir,
            fs_commands::fs_rename,
            fs_commands::fs_delete,
            fs_commands::fs_copy_into,
            fs_commands::fs_move_into,
            fs_commands::fs_reveal,
            fs_commands::dialog_pick_folder,
            fs_commands::dialog_pick_files,
            fs_commands::dialog_save_as,
            workspace_commands::workspace_open,
            workspace_commands::workspace_close,
            workspace_commands::workspace_find_files,
            session_commands::settings_get,
            session_commands::settings_set,
            session_commands::settings_reload,
            session_commands::session_save,
            session_commands::buffer_save,
            session_commands::buffer_load,
            session_commands::buffer_remove,
            session_commands::buffers_prune,
            session_commands::recent_folders,
            session_commands::recent_remove,
            session_commands::window_set_title,
            terminal_commands::terminal_profiles,
            terminal_commands::terminal_open,
            terminal_commands::terminal_run,
            terminal_commands::terminal_attach,
            terminal_commands::terminal_write,
            terminal_commands::terminal_resize,
            terminal_commands::terminal_close,
            terminal_commands::terminals_list,
            toolchain_commands::toolchains_detect,
            toolchain_commands::toolchain_msvc_env,
            toolchain_commands::path_refresh,
            toolchain_commands::program_which,
            toolchain_commands::run_capture,
            toolchain_commands::winget_args,
            toolchain_commands::trust_get,
            toolchain_commands::trust_set,
            search_commands::search_start,
            search_commands::search_cancel,
            search_commands::search_replace_files,
            search_commands::search_replace_at,
            search_commands::search_edits,
            git_commands::git_status,
            git_commands::git_show,
            git_commands::git_stage,
            git_commands::git_unstage,
            git_commands::git_discard,
            git_commands::git_set_index,
            git_commands::git_commit,
            git_commands::git_branches,
            git_commands::git_switch,
            git_commands::git_delete_branch,
            git_commands::git_remote,
            git_commands::git_log,
            git_commands::git_blame,
            git_commands::git_stash,
            git_commands::git_init,
            git_commands::git_clone,
            git_commands::git_identity,
            lsp_commands::lsp_start,
            lsp_commands::lsp_send,
            lsp_commands::lsp_stop,
            lsp_commands::tools_dir,
            lsp_commands::tools_install_archive,
            debug_commands::dap_spawn,
            debug_commands::dap_connect,
            debug_commands::dap_listen,
            debug_commands::dap_accept,
            debug_commands::dap_send,
            debug_commands::dap_close,
            kernel_commands::kernel_specs,
            kernel_commands::kernel_start,
            kernel_commands::kernel_execute,
            kernel_commands::kernel_complete,
            kernel_commands::kernel_inspect,
            kernel_commands::kernel_input,
            kernel_commands::kernel_interrupt,
            kernel_commands::kernel_restart,
            kernel_commands::kernel_shutdown,
            plugin_commands::plugins_list,
            plugin_commands::plugin_stage,
            plugin_commands::plugin_install,
            plugin_commands::plugin_discard,
            plugin_commands::plugin_uninstall,
            plugin_commands::plugin_set_enabled,
            plugin_commands::plugin_read_text,
        ])
        .setup(|app| {
            let data = data_dir(app.handle())?;
            std::fs::create_dir_all(&data)?;
            app.manage(state::AppState::new(&data));
            app.manage(search_commands::Searches::default());
            app.manage(lsp_commands::LspSessions::default());
            app.manage(debug_commands::DebugConnections::default());
            app.manage(kernel_commands::Kernels::default());
            app.manage(std::sync::Arc::new(lathe_core::terminal::Terminals::new()));
            app.state::<cli::Waits>()
                .register(&std::env::args().skip(1).collect::<Vec<_>>());
            window::create_main(app.handle(), &data)?;
            Ok(())
        })
        .build(context);

    match result {
        Ok(app) => app.run(|handle, event| {
            // Quitting lets every `lathe --wait` go.
            if let tauri::RunEvent::Exit = event {
                handle.state::<cli::Waits>().release_all();
            }
        }),
        Err(err) => guard::fatal(&format!("Lathe could not start.\n\n{err}")),
    }
}

/// Where Lathe keeps its data: %LOCALAPPDATA%\app.lathe, or a test run's own folder (see
/// `guard::test_data_dir`).
fn data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
    match guard::test_data_dir() {
        Some(dir) => Ok(dir),
        None => app.path().app_local_data_dir(),
    }
}
