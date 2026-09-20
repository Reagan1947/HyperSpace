mod app_settings;
mod fs_open;
mod fs_watch;
mod git_service;
mod project_settings;
mod terminal_service;
mod workspace_store;

use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    window::Color,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

const WORKSPACE_FILE: &str = "workspace.json";
const CURRENT_PROJECT_FILE: &str = "current_project.json";
const MENU_NEW_PROJECT: &str = "new-project";
const MENU_OPEN_FOLDER: &str = "open-folder";
const MENU_SETTINGS: &str = "settings";
const MENU_SETTINGS_TERMINAL: &str = "settings-terminal";
const MENU_SETTINGS_TAGS: &str = "settings-tags";
const MENU_PROJECT_SETTINGS: &str = "project-settings";
const OPEN_FOLDER_REQUESTED_EVENT: &str = "open-folder-requested";
const SETTINGS_NAVIGATE_EVENT: &str = "settings-navigate";
const NEW_PROJECT_WINDOW_LABEL: &str = "new-project";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const PROJECT_SETTINGS_WINDOW_LABEL: &str = "project-settings";

#[derive(serde::Serialize, serde::Deserialize)]
struct CurrentProject {
    path: String,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn current_project_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(CURRENT_PROJECT_FILE))
}

fn read_current_project(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let config_path = current_project_config_path(app)?;
    if !config_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
    let config: CurrentProject = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid current project config: {error}"))?;
    let path = PathBuf::from(config.path);
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    Ok(Some(path))
}

fn write_current_project(app: &AppHandle, project_path: &Path) -> Result<(), String> {
    let config_path = current_project_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let payload = serde_json::to_string_pretty(&CurrentProject {
        path: project_path.to_string_lossy().into_owned(),
    })
    .map_err(|error| error.to_string())?;

    fs::write(config_path, payload).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_workspace(app: AppHandle) -> Result<Option<String>, String> {
    if let Some(project_path) = read_current_project(&app)? {
        let workspace = workspace_store::open_project_workspace(&project_path);
        if let Err(error) = fs_watch::start_watching(&app, &project_path) {
            eprintln!("Failed to watch project: {error}");
        }
        return workspace;
    }
    let path = app_data_dir(&app)?.join(WORKSPACE_FILE);
    if !path.exists() {
        return Ok(None);
    }

    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_workspace(app: AppHandle, payload: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|error| format!("Workspace payload is not valid JSON: {error}"))?;
    if let Some(project_path) = read_current_project(&app)? {
        fs_watch::quiet_watch(&app);
        return workspace_store::save_project_workspace(&project_path, &payload);
    }
    workspace_store::write_atomic(&app_data_dir(&app)?.join(WORKSPACE_FILE), &payload)
}

#[tauri::command]
fn app_data_directory(app: AppHandle) -> Result<String, String> {
    app_data_dir(&app).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn default_projects_directory(app: AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?;
    Ok(documents.join("HyperSpace").to_string_lossy().into_owned())
}

#[tauri::command]
fn get_current_project(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_current_project(&app)?.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_project(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let project_path = PathBuf::from(path.trim());
    if project_path.as_os_str().is_empty() {
        return Err("Project path is required".into());
    }
    if !project_path.is_dir() {
        return Err("所选路径不是有效的文件夹".into());
    }

    let workspace = workspace_store::open_project_workspace(&project_path)?;
    write_current_project(&app, &project_path)?;
    if let Err(error) = fs_watch::start_watching(&app, &project_path) {
        eprintln!("Failed to watch project: {error}");
    }
    Ok(workspace)
}

#[tauri::command]
fn create_project(
    app: AppHandle,
    path: String,
    enable_git: bool,
    workspace_payload: String,
) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&workspace_payload)
        .map_err(|error| format!("Workspace payload is not valid JSON: {error}"))?;

    let project_path = PathBuf::from(path.trim());
    if project_path.as_os_str().is_empty() {
        return Err("Project path is required".into());
    }

    if project_path.exists() {
        let is_empty = fs::read_dir(&project_path)
            .map_err(|error| error.to_string())?
            .next()
            .is_none();
        if !is_empty {
            return Err("目标文件夹已存在且不为空，请选择其他位置".into());
        }
    } else {
        fs::create_dir_all(&project_path).map_err(|error| error.to_string())?;
    }

    if enable_git {
        let toolchain = project_settings::resolve_git_toolchain(&app, &project_path)?;
        git_service::init_repository(&toolchain, &project_path)?;
    } else {
        git_service::ensure_project_support_files(&project_path)?;
    }

    workspace_store::save_project_workspace(&project_path, &workspace_payload)?;
    write_current_project(&app, &project_path)?;
    if let Err(error) = fs_watch::start_watching(&app, &project_path) {
        eprintln!("Failed to watch project: {error}");
    }

    Ok(project_path.to_string_lossy().into_owned())
}

fn require_current_project(app: &AppHandle) -> Result<PathBuf, String> {
    read_current_project(app)?.ok_or_else(|| "当前没有打开的项目".into())
}

#[tauri::command]
fn git_repository_info(app: AppHandle) -> Result<git_service::GitRepositoryInfo, String> {
    let project_path = require_current_project(&app)?;
    let toolchain = project_settings::resolve_git_toolchain(&app, &project_path)?;
    Ok(git_service::repository_info(&toolchain, &project_path))
}

#[tauri::command]
fn git_commit_all(
    app: AppHandle,
    message: String,
) -> Result<git_service::GitRepositoryInfo, String> {
    let project_path = require_current_project(&app)?;
    let toolchain = project_settings::resolve_git_toolchain(&app, &project_path)?;
    git_service::commit_all(&toolchain, &project_path, &message)
}

#[tauri::command]
fn search_workspace(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<workspace_store::SearchResult>, String> {
    workspace_store::search_project(&require_current_project(&app)?, &query, limit.unwrap_or(20))
}

#[tauri::command]
fn import_pdf(app: AppHandle, source_path: String) -> Result<git_service::ImportedFile, String> {
    let project_path = require_current_project(&app)?;
    let toolchain = project_settings::resolve_git_toolchain(&app, &project_path)?;
    git_service::import_pdf(&toolchain, &project_path, Path::new(&source_path))
}

#[tauri::command]
fn create_workspace_entry(
    app: AppHandle,
    parent_path: String,
    kind: String,
) -> Result<workspace_store::CreatedWorkspaceEntry, String> {
    fs_watch::quiet_watch(&app);
    workspace_store::create_project_entry(&require_current_project(&app)?, &parent_path, &kind)
}

#[tauri::command]
fn rename_workspace_entry(
    app: AppHandle,
    local_path: String,
    new_name: String,
) -> Result<String, String> {
    fs_watch::quiet_watch(&app);
    workspace_store::rename_project_entry(&require_current_project(&app)?, &local_path, &new_name)
}

#[tauri::command]
fn delete_workspace_entries(app: AppHandle, local_paths: Vec<String>) -> Result<(), String> {
    fs_watch::quiet_watch(&app);
    workspace_store::delete_project_entries(&require_current_project(&app)?, &local_paths)
}

#[tauri::command]
fn move_workspace_entry(
    app: AppHandle,
    local_path: String,
    destination_parent: String,
) -> Result<String, String> {
    fs_watch::quiet_watch(&app);
    workspace_store::move_project_entry(
        &require_current_project(&app)?,
        &local_path,
        &destination_parent,
    )
}

#[tauri::command]
fn reveal_in_finder(app: AppHandle, local_path: String) -> Result<(), String> {
    fs_open::reveal_in_finder(&require_current_project(&app)?, &local_path)
}

#[tauri::command]
fn open_in_terminal(app: AppHandle, local_path: String) -> Result<(), String> {
    fs_open::open_in_terminal(&require_current_project(&app)?, &local_path)
}

#[tauri::command]
fn get_project_settings(
    app: AppHandle,
) -> Result<project_settings::ProjectSettingsSnapshot, String> {
    project_settings::snapshot(&app, &require_current_project(&app)?)
}

#[tauri::command]
fn save_project_settings(
    app: AppHandle,
    request: project_settings::SaveProjectSettingsRequest,
) -> Result<project_settings::ProjectSettingsSnapshot, String> {
    project_settings::save(&app, &require_current_project(&app)?, request)
}

#[tauri::command]
fn import_ssh_key(
    app: AppHandle,
    source_path: String,
    name: String,
) -> Result<project_settings::ProjectSettingsSnapshot, String> {
    project_settings::import_key(
        &app,
        &require_current_project(&app)?,
        Path::new(&source_path),
        &name,
    )
}

#[tauri::command]
fn generate_ssh_key(
    app: AppHandle,
    name: String,
    comment: String,
) -> Result<project_settings::ProjectSettingsSnapshot, String> {
    project_settings::generate_key(&app, &require_current_project(&app)?, &name, &comment)
}

#[tauri::command]
fn delete_ssh_key(
    app: AppHandle,
    name: String,
) -> Result<project_settings::ProjectSettingsSnapshot, String> {
    project_settings::delete_key(&app, &require_current_project(&app)?, &name)
}

async fn open_new_project_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(NEW_PROJECT_WINDOW_LABEL) {
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        NEW_PROJECT_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=new-project".into()),
    )
    .title("新建项目")
    .inner_size(480.0, 560.0)
    .min_inner_size(420.0, 480.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(false)
    .background_color(Color(0xf2, 0xf2, 0xf2, 255))
    .center();

    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|error| error.to_string())?;
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_app_settings(app: AppHandle) -> Result<app_settings::AppSettings, String> {
    app_settings::load(&app)
}

#[tauri::command]
fn save_app_settings(
    app: AppHandle,
    settings: app_settings::AppSettings,
) -> Result<app_settings::AppSettings, String> {
    let settings = app_settings::save(&app, settings)?;
    app.emit(app_settings::APP_SETTINGS_CHANGED_EVENT, &settings)
        .map_err(|error| error.to_string())?;
    Ok(settings)
}

#[tauri::command]
fn list_system_fonts() -> Vec<app_settings::SystemFont> {
    app_settings::list_system_fonts()
}

async fn open_settings_window(app: AppHandle, section: Option<&str>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window.set_focus().map_err(|error| error.to_string())?;
        if let Some(section) = section {
            app.emit(SETTINGS_NAVIGATE_EVENT, section)
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    let url = match section {
        Some(section) if !section.is_empty() => format!("index.html?window=settings&section={section}"),
        _ => "index.html?window=settings".into(),
    };

    let mut builder = WebviewWindowBuilder::new(
        &app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(url.into()),
    )
    .title("Settings")
    .inner_size(820.0, 560.0)
    .min_inner_size(700.0, 460.0)
    .resizable(true)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(false)
    .background_color(Color(0xf2, 0xf2, 0xf2, 255))
    .center();

    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|error| error.to_string())?;
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

async fn open_project_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PROJECT_SETTINGS_WINDOW_LABEL) {
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        PROJECT_SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=project-settings".into()),
    )
    .title("项目设置")
    .inner_size(720.0, 680.0)
    .min_inner_size(640.0, 560.0)
    .resizable(true)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(false)
    .background_color(Color(0xf2, 0xf2, 0xf2, 255))
    .center();

    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|error| error.to_string())?;
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let settings_item = MenuItemBuilder::with_id(MENU_SETTINGS, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let app_submenu = SubmenuBuilder::new(app, "HyperSpace")
        .about(Some(AboutMetadata {
            name: Some("HyperSpace".into()),
            ..Default::default()
        }))
        .separator()
        .item(&settings_item)
        .text(MENU_PROJECT_SETTINGS, "项目设置…")
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let open_folder_item = MenuItemBuilder::with_id(MENU_OPEN_FOLDER, "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .text(MENU_NEW_PROJECT, "New Project")
        .item(&open_folder_item)
        .separator()
        .item(&PredefinedMenuItem::close_window(
            app,
            Some("Close Window"),
        )?)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let settings_submenu = SubmenuBuilder::new(app, "Settings")
        .text(MENU_SETTINGS_TERMINAL, "Terminal Font")
        .text(MENU_SETTINGS_TAGS, "标签管理")
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&settings_submenu)
        .item(&window_submenu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(terminal_service::TerminalState::default())
        .manage(fs_watch::FsWatchState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id().as_ref() == MENU_NEW_PROJECT {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = open_new_project_window(app).await {
                            eprintln!("Failed to open New Project window: {error}");
                        }
                    });
                } else if event.id().as_ref() == MENU_OPEN_FOLDER {
                    if let Err(error) = app.emit(OPEN_FOLDER_REQUESTED_EVENT, ()) {
                        eprintln!("Failed to request opening a folder: {error}");
                    }
                } else if event.id().as_ref() == MENU_SETTINGS
                    || event.id().as_ref() == MENU_SETTINGS_TERMINAL
                    || event.id().as_ref() == MENU_SETTINGS_TAGS
                {
                    let section = match event.id().as_ref() {
                        MENU_SETTINGS_TERMINAL => Some("terminal"),
                        MENU_SETTINGS_TAGS => Some("tags"),
                        _ => None,
                    };
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = open_settings_window(app, section).await {
                            eprintln!("Failed to open Settings window: {error}");
                        }
                    });
                } else if event.id().as_ref() == MENU_PROJECT_SETTINGS {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = open_project_settings_window(app).await {
                            eprintln!("Failed to open project settings window: {error}");
                        }
                    });
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            app_data_directory,
            default_projects_directory,
            get_current_project,
            open_project,
            create_project,
            git_repository_info,
            git_commit_all,
            search_workspace,
            import_pdf,
            create_workspace_entry,
            rename_workspace_entry,
            delete_workspace_entries,
            move_workspace_entry,
            reveal_in_finder,
            open_in_terminal,
            get_project_settings,
            save_project_settings,
            get_app_settings,
            save_app_settings,
            list_system_fonts,
            import_ssh_key,
            generate_ssh_key,
            delete_ssh_key,
            terminal_service::terminal_start,
            terminal_service::terminal_write,
            terminal_service::terminal_resize,
            terminal_service::terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running HyperSpace");
}
