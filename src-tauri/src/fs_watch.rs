use notify::{RecursiveMode, Watcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{app_settings, workspace_store};

pub const WORKSPACE_TREE_CHANGED_EVENT: &str = "workspace-tree-changed";
const DEBOUNCE: Duration = Duration::from_millis(300);
const QUIET_PERIOD: Duration = Duration::from_millis(1500);

pub struct FsWatchState {
    inner: Mutex<WatchInner>,
}

struct WatchInner {
    debouncer: Option<Debouncer<notify::RecommendedWatcher>>,
    project_path: Option<PathBuf>,
    quiet_until: Instant,
}

impl Default for FsWatchState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(WatchInner {
                debouncer: None,
                project_path: None,
                quiet_until: Instant::now(),
            }),
        }
    }
}

pub fn start_watching(app: &AppHandle, project_path: &Path) -> Result<(), String> {
    let app_for_handler = app.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
        handle_watch_events(&app_for_handler, result);
    })
    .map_err(|error| error.to_string())?;
    Watcher::watch(debouncer.watcher(), project_path, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;

    let state = app.state::<FsWatchState>();
    let mut inner = state.inner.lock().map_err(|error| error.to_string())?;
    inner.debouncer = Some(debouncer);
    inner.project_path = Some(project_path.to_path_buf());
    inner.quiet_until = Instant::now();
    Ok(())
}

/// Ignore filesystem events caused by our own writes.
///
/// A follow-up full project scan used to land on the UI thread shortly after
/// every autosave, which is the hitch after a newline or a window switch.
pub fn quiet_watch(app: &AppHandle) {
    let Some(state) = app.try_state::<FsWatchState>() else {
        return;
    };
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    inner.quiet_until = Instant::now() + QUIET_PERIOD;
}

fn handle_watch_events(app: &AppHandle, result: DebounceEventResult) {
    let events = match result {
        Ok(events) => events,
        Err(errors) => {
            eprintln!("Project watch error: {errors:?}");
            return;
        }
    };
    let Some(state) = app.try_state::<FsWatchState>() else {
        return;
    };
    let Ok(inner) = state.inner.lock() else {
        return;
    };
    let Some(project) = inner.project_path.clone() else {
        return;
    };
    let options = app_settings::scan_options(app);
    if events.iter().all(|event| {
        workspace_store::is_ignored_fs_event_with_options(&project, &event.path, &options)
    }) {
        return;
    }
    if Instant::now() < inner.quiet_until {
        return;
    }
    drop(inner);
    emit_workspace_tree(app, &project);
}

pub fn refresh_workspace_tree(app: &AppHandle) {
    let Some(state) = app.try_state::<FsWatchState>() else {
        return;
    };
    let Ok(inner) = state.inner.lock() else {
        return;
    };
    let Some(project) = inner.project_path.clone() else {
        return;
    };
    drop(inner);
    emit_workspace_tree(app, &project);
}

fn emit_workspace_tree(app: &AppHandle, project: &Path) {
    let options = app_settings::scan_options(app);
    match workspace_store::scan_project_workspace_with_options(project, &options) {
        Ok(workspace) => {
            if let Err(error) = app.emit(WORKSPACE_TREE_CHANGED_EVENT, workspace) {
                eprintln!("Failed to emit workspace tree change: {error}");
            }
        }
        Err(error) => eprintln!("Failed to refresh workspace from disk: {error}"),
    }
}
