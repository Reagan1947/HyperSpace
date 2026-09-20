use notify::{RecursiveMode, Watcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::workspace_store;

pub const WORKSPACE_TREE_CHANGED_EVENT: &str = "workspace-tree-changed";
const DEBOUNCE: Duration = Duration::from_millis(300);
const QUIET_PERIOD: Duration = Duration::from_millis(500);

pub struct FsWatchState {
    inner: Mutex<WatchInner>,
}

struct WatchInner {
    debouncer: Option<Debouncer<notify::RecommendedWatcher>>,
    project_path: Option<PathBuf>,
    quiet_until: Instant,
    generation: u64,
    pending: bool,
}

impl Default for FsWatchState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(WatchInner {
                debouncer: None,
                project_path: None,
                quiet_until: Instant::now(),
                generation: 0,
                pending: false,
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
    inner.pending = false;
    inner.generation = inner.generation.wrapping_add(1);
    Ok(())
}

pub fn quiet_watch(app: &AppHandle) {
    let Some(state) = app.try_state::<FsWatchState>() else {
        return;
    };
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    inner.quiet_until = Instant::now() + QUIET_PERIOD;
    inner.generation = inner.generation.wrapping_add(1);
    let generation = inner.generation;
    drop(inner);

    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(QUIET_PERIOD + Duration::from_millis(50));
        let Some(state) = app.try_state::<FsWatchState>() else {
            return;
        };
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if inner.generation != generation {
            return;
        }
        let pending = std::mem::take(&mut inner.pending);
        let project = inner.project_path.clone();
        drop(inner);
        if pending {
            if let Some(project) = project {
                emit_workspace_tree(&app, &project);
            }
        }
    });
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
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    let Some(project) = inner.project_path.clone() else {
        return;
    };
    if events
        .iter()
        .all(|event| workspace_store::is_ignored_fs_event(&project, &event.path))
    {
        return;
    }
    if Instant::now() < inner.quiet_until {
        inner.pending = true;
        return;
    }
    inner.pending = false;
    drop(inner);
    emit_workspace_tree(app, &project);
}

fn emit_workspace_tree(app: &AppHandle, project: &Path) {
    match workspace_store::scan_project_workspace(project) {
        Ok(workspace) => {
            if let Err(error) = app.emit(WORKSPACE_TREE_CHANGED_EVENT, workspace) {
                eprintln!("Failed to emit workspace tree change: {error}");
            }
        }
        Err(error) => eprintln!("Failed to refresh workspace from disk: {error}"),
    }
}
