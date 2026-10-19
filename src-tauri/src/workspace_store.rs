use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

const SCHEMA_VERSION: u64 = 3;
/// Note front matter stays on the v2 markdown format so a workspace schema bump
/// does not rewrite every page file.
const NOTE_FRONT_MATTER_VERSION: u64 = 2;
const PROJECT_DIR_NAME: &str = ".hyperspace";
const LEGACY_WORKSPACE_FILE: &str = "workspace.json";
const MANIFEST_FILE: &str = "manifest.json";
const STATE_FILE: &str = "state.json";
const SEARCH_INDEX_FILE: &str = "search-index.json";
const VDITOR_MIGRATION_DIR: &str = "migrations/pre-vditor";
const MAX_SCANNED_NODES: usize = 20_000;
const NEW_PAGE_FILE_NAME: &str = "未命名页面.md";
const NEW_FOLDER_NAME: &str = "新建文件夹";
const ASSETS_DIRECTORY_NAME: &str = ".assets";
const IGNORED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".hyperspace",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub exclude_hidden: bool,
    pub visible_hidden_entries: HashSet<String>,
}

impl ScanOptions {
    pub fn new(
        exclude_hidden: bool,
        visible_hidden_entries: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            exclude_hidden,
            visible_hidden_entries: visible_hidden_entries.into_iter().map(Into::into).collect(),
        }
    }
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            exclude_hidden: true,
            visible_hidden_entries: HashSet::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub node_id: String,
    pub title: String,
    pub kind: String,
    pub file_type: Option<String>,
    pub path: String,
    pub snippet: String,
    pub score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkspaceEntry {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub relative_path: String,
    pub file_type: Option<String>,
    pub size: Option<String>,
    pub file_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocument {
    node_id: String,
    title: String,
    kind: String,
    file_type: Option<String>,
    path: String,
    tags: Vec<String>,
    content: String,
    updated_at: String,
}

fn hyperspace_dir(project_path: &Path) -> PathBuf {
    project_path.join(PROJECT_DIR_NAME)
}

fn project_file(project_path: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Invalid project file path: {relative_path}"));
    }
    let target = project_path.join(relative);
    let canonical_project = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
    if !canonical_target.starts_with(&canonical_project) {
        return Err(format!(
            "Project file is outside the workspace: {relative_path}"
        ));
    }
    Ok(canonical_target)
}

/// Resolves a workspace-relative path to an existing absolute path.
/// An empty `local_path` is the project root.
pub(crate) fn resolve_existing_project_path(
    project_path: &Path,
    local_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = local_path.trim();
    if trimmed.is_empty() {
        return fs::canonicalize(project_path).map_err(|error| error.to_string());
    }
    project_file(project_path, trimmed)
}

fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn is_markdown_file_node(node: &Value) -> bool {
    node.get("kind").and_then(Value::as_str) == Some("file")
        && matches!(
            node.get("fileType").and_then(Value::as_str),
            Some("MD" | "MARKDOWN")
        )
}

fn is_editable_markdown_node(node: &Value) -> bool {
    node.get("kind").and_then(Value::as_str) == Some("page") || is_markdown_file_node(node)
}

fn read_markdown_file(project_path: &Path, relative_path: &str) -> Option<String> {
    let path = project_file(project_path, relative_path).ok()?;
    fs::read_to_string(path).ok()
}

fn strip_generated_front_matter(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return markdown.to_string();
    };
    let Some(end) = rest.find("\n---") else {
        return markdown.to_string();
    };
    let front = &rest[..end];
    let generated = front.lines().any(|line| line.starts_with("id: "))
        && front
            .lines()
            .any(|line| line.starts_with("schemaVersion:"));
    if !generated {
        return markdown.to_string();
    }
    rest[end + 4..].trim_start_matches('\n').trim_end().to_string()
}

fn document_markdown(document: &Value) -> String {
    let from_field = document
        .get("markdown")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !from_field.trim().is_empty() {
        return from_field.to_string();
    }
    if let Some(blocks) = document.get("blocks") {
        let converted = legacy_blocks_to_markdown(blocks);
        if !converted.trim().is_empty() {
            return converted;
        }
    }
    if let Some(editor_document) = document.get("editorDocument") {
        let mut text = String::new();
        plain_text(editor_document, &mut text);
        if !text.trim().is_empty() {
            return text;
        }
    }
    from_field.to_string()
}

fn filesystem_node_id(relative_path: &str) -> String {
    let digest = Sha256::digest(relative_path.as_bytes());
    let short_hash = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("fs-{short_hash}")
}

fn unique_filesystem_node_id(relative_path: &str, used_ids: &HashSet<String>) -> String {
    let base = filesystem_node_id(relative_path);
    if !used_ids.contains(&base) {
        return base;
    }
    for index in 2..10_000 {
        let candidate = filesystem_node_id(&format!("{relative_path}#{index}"));
        if !used_ids.contains(&candidate) {
            return candidate;
        }
    }
    filesystem_node_id(&format!("{relative_path}#new"))
}

fn workspace_node_ids(nodes: &[Value]) -> HashSet<String> {
    nodes
        .iter()
        .filter_map(|node| node.get("id")?.as_str().map(str::to_string))
        .filter(|id| !id.is_empty())
        .collect()
}

fn loaded_workspace_nodes(project_path: &Path) -> Vec<Value> {
    let Ok(Some(payload)) = load_project_workspace(project_path) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&payload)
        .ok()
        .and_then(|workspace| workspace.get("nodes")?.as_array().cloned())
        .unwrap_or_default()
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &fs::Metadata) -> Option<String> {
    None
}

fn display_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let (value, unit) = if bytes < 1024 * 1024 {
        (bytes as f64 / 1024.0, "KB")
    } else if bytes < 1024 * 1024 * 1024 {
        (bytes as f64 / (1024.0 * 1024.0), "MB")
    } else {
        (bytes as f64 / (1024.0 * 1024.0 * 1024.0), "GB")
    };
    format!("{value:.1} {unit}")
}

fn display_modified(metadata: &fs::Metadata) -> String {
    let Ok(modified) = metadata.modified() else {
        return String::new();
    };
    let Ok(elapsed) = modified.elapsed() else {
        return "刚刚".into();
    };
    let minutes = elapsed.as_secs() / 60;
    if minutes < 1 {
        "刚刚".into()
    } else if minutes < 60 {
        format!("{minutes} 分钟前")
    } else if minutes < 24 * 60 {
        format!("{} 小时前", minutes / 60)
    } else {
        format!("{} 天前", minutes / (24 * 60))
    }
}

fn scan_directory(
    project_path: &Path,
    directory: &Path,
    parent_id: Option<&str>,
    existing_by_path: &HashMap<String, Value>,
    existing_by_identity: &HashMap<String, Value>,
    nodes: &mut Vec<Value>,
    options: &ScanOptions,
    reserved_ids: &mut HashSet<String>,
    assigned_ids: &mut HashSet<String>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| {
        let is_file = entry.file_type().map(|kind| kind.is_file()).unwrap_or(true);
        (is_file, entry.file_name().to_string_lossy().to_lowercase())
    });

    for entry in entries {
        if nodes.len() >= MAX_SCANNED_NODES {
            return Err(format!(
                "文件夹内容超过 {MAX_SCANNED_NODES} 项，无法完整展示"
            ));
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_entry(&name, file_type.is_dir(), options) {
            continue;
        }
        let path = entry.path();
        let relative_path = path
            .strip_prefix(project_path)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let identity = file_identity(&metadata);
        let existing = existing_by_path.get(&relative_path).or_else(|| {
            identity
                .as_ref()
                .and_then(|value| existing_by_identity.get(value))
        });
        let existing_id = existing
            .and_then(|node| node.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let id = match existing_id {
            Some(existing_id) if !assigned_ids.contains(existing_id) => existing_id.to_string(),
            _ => unique_filesystem_node_id(&relative_path, reserved_ids),
        };
        assigned_ids.insert(id.clone());
        reserved_ids.insert(id.clone());
        let mut node = existing.cloned().unwrap_or_else(|| json!({}));
        let object = node
            .as_object_mut()
            .ok_or_else(|| "Workspace node must be an object".to_string())?;
        object.insert("id".into(), Value::String(id.clone()));
        object.insert(
            "parentId".into(),
            parent_id
                .map(|value| Value::String(value.into()))
                .unwrap_or(Value::Null),
        );
        object.insert(
            "kind".into(),
            Value::String(if file_type.is_dir() { "folder" } else { "file" }.into()),
        );
        object.insert("title".into(), Value::String(name));
        object.insert(
            "updatedAt".into(),
            Value::String(display_modified(&metadata)),
        );
        object.insert("localPath".into(), Value::String(relative_path));
        if let Some(identity) = identity {
            object.insert("fileIdentity".into(), Value::String(identity));
        }
        if file_type.is_file() {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("FILE")
                .to_uppercase();
            object.insert("fileType".into(), Value::String(extension));
            object.insert("size".into(), Value::String(display_size(metadata.len())));
        } else {
            object.remove("fileType");
            object.remove("size");
        }
        nodes.push(node);

        if file_type.is_dir() {
            scan_directory(
                project_path,
                &path,
                Some(&id),
                existing_by_path,
                existing_by_identity,
                nodes,
                options,
                reserved_ids,
                assigned_ids,
            )?;
        }
    }
    Ok(())
}

fn is_allowed_hidden_directory(name: &str) -> bool {
    name == ASSETS_DIRECTORY_NAME
}

fn should_skip_entry(name: &str, is_dir: bool, options: &ScanOptions) -> bool {
    if name.ends_with(".tmp") || name == PROJECT_DIR_NAME {
        return true;
    }
    if is_allowed_hidden_directory(name) || options.visible_hidden_entries.contains(name) {
        return false;
    }
    if is_dir && IGNORED_DIRECTORY_NAMES.contains(&name) {
        return true;
    }
    options.exclude_hidden && name.starts_with('.')
}

fn validate_entry_name(name: &str, is_dir: bool) -> Result<(), String> {
    let name_path = Path::new(name);
    if name.is_empty()
        || name_path.components().count() != 1
        || !matches!(
            name_path.components().next(),
            Some(Component::Normal(_))
        )
        || (name.starts_with('.') && !(is_dir && is_allowed_hidden_directory(name)))
    {
        return Err("文件名不能为空、不能以点开头，也不能包含路径分隔符".into());
    }
    Ok(())
}

pub fn is_ignored_fs_event(project_path: &Path, path: &Path) -> bool {
    is_ignored_fs_event_with_options(project_path, path, &ScanOptions::default())
}

pub fn is_ignored_fs_event_with_options(
    project_path: &Path,
    path: &Path,
    options: &ScanOptions,
) -> bool {
    let Ok(relative) = path.strip_prefix(project_path) else {
        return true;
    };
    if relative.as_os_str().is_empty() {
        return false;
    }
    relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        should_skip_entry(&name, true, options)
    })
}

pub fn scan_project_workspace(project_path: &Path) -> Result<Value, String> {
    scan_project_workspace_with_options(project_path, &ScanOptions::default())
}

pub fn scan_project_workspace_with_options(
    project_path: &Path,
    options: &ScanOptions,
) -> Result<Value, String> {
    let loaded = load_project_workspace(project_path)?;
    let mut workspace = loaded
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| format!("Invalid workspace: {error}"))?
        .unwrap_or_else(|| {
            json!({
                "nodes": [],
                "noteMarkdown": {}
            })
        });

    let existing_nodes = workspace
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existing_by_path = existing_nodes
        .iter()
        .filter_map(|node| {
            let path = node.get("localPath").and_then(Value::as_str)?;
            (!path.is_empty()).then(|| (path.to_string(), node.clone()))
        })
        .collect::<HashMap<_, _>>();
    let existing_by_identity = existing_nodes
        .iter()
        .filter_map(|node| {
            Some((
                node.get("fileIdentity")?.as_str()?.to_string(),
                node.clone(),
            ))
        })
        .collect::<HashMap<_, _>>();

    workspace["nodes"] = Value::Array(Vec::new());

    let mut scanned_nodes = Vec::new();
    let mut reserved_ids = workspace_node_ids(&existing_nodes);
    let mut assigned_ids = HashSet::new();
    scan_directory(
        project_path,
        project_path,
        None,
        &existing_by_path,
        &existing_by_identity,
        &mut scanned_nodes,
        options,
        &mut reserved_ids,
        &mut assigned_ids,
    )?;
    let first_node_id = {
        let nodes = workspace
            .as_object_mut()
            .ok_or_else(|| "Workspace must be a JSON object".to_string())?
            .entry("nodes")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| "Workspace nodes must be an array".to_string())?;
        nodes.extend(scanned_nodes);
        nodes.first().and_then(|node| node.get("id")).cloned()
    };

    let markdown_files = workspace
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| is_markdown_file_node(node))
        .filter_map(|node| {
            Some((
                node.get("id")?.as_str()?.to_string(),
                node.get("localPath")?.as_str()?.to_string(),
            ))
        })
        .collect::<Vec<_>>();
    let note_markdown = workspace
        .as_object_mut()
        .ok_or_else(|| "Workspace must be a JSON object".to_string())?
        .entry("noteMarkdown")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Workspace noteMarkdown must be an object".to_string())?;
    for (id, relative_path) in markdown_files {
        let path = project_file(project_path, &relative_path)?;
        let markdown = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        note_markdown.insert(id, Value::String(strip_generated_front_matter(&markdown)));
    }

    let selected_missing = workspace
        .get("selectedNodeId")
        .and_then(Value::as_str)
        .map(|id| {
            workspace
                .get("nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .all(|node| node.get("id").and_then(Value::as_str) != Some(id))
        })
        .unwrap_or(true);
    if selected_missing {
        let preferred = workspace
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|node| is_editable_markdown_node(node))
            .and_then(|node| node.get("id"))
            .cloned()
            .or(first_node_id);
        if let Some(id) = preferred {
            workspace["selectedNodeId"] = id;
        }
    }
    let valid_ids = workspace
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| node.get("id")?.as_str().map(str::to_string))
        .collect::<HashSet<_>>();
    if let Some(note_markdown) = workspace
        .get_mut("noteMarkdown")
        .and_then(Value::as_object_mut)
    {
        note_markdown.retain(|id, _| valid_ids.contains(id));
    }
    Ok(workspace)
}

pub fn open_project_workspace(project_path: &Path) -> Result<Option<String>, String> {
    open_project_workspace_with_options(project_path, &ScanOptions::default())
}

pub fn open_project_workspace_with_options(
    project_path: &Path,
    options: &ScanOptions,
) -> Result<Option<String>, String> {
    let workspace = scan_project_workspace_with_options(project_path, options)?;
    let is_empty = workspace
        .get("nodes")
        .and_then(Value::as_array)
        .map(Vec::is_empty)
        .unwrap_or(true);
    if is_empty {
        return Ok(None);
    }
    serde_json::to_string(&workspace)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn safe_project_entry(project_path: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("无效的项目相对路径".into());
    }
    let path = project_path.join(relative);
    if !path.exists() {
        return Err(format!("文件不存在：{relative_path}"));
    }
    Ok(path)
}

pub fn rename_project_entry(
    project_path: &Path,
    relative_path: &str,
    new_name: &str,
) -> Result<String, String> {
    let source = safe_project_entry(project_path, relative_path)?;
    let normalized = new_name.trim();
    validate_entry_name(normalized, source.is_dir())?;
    let destination = source
        .parent()
        .ok_or_else(|| "无法重命名项目根目录".to_string())?
        .join(normalized);
    if source == destination {
        return Ok(relative_path.replace('\\', "/"));
    }
    if destination.exists() {
        return Err(format!("同名文件已存在：{normalized}"));
    }
    fs::rename(&source, &destination).map_err(|error| format!("重命名失败：{error}"))?;
    destination
        .strip_prefix(project_path)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|error| error.to_string())
}

pub fn delete_project_entries(
    project_path: &Path,
    relative_paths: &[String],
) -> Result<(), String> {
    let mut paths = relative_paths
        .iter()
        .map(|relative| safe_project_entry(project_path, relative))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    paths.dedup();
    for path in paths {
        if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
        .map_err(|error| format!("删除 {} 失败：{error}", path.display()))?;
    }
    Ok(())
}

pub fn move_project_entry(
    project_path: &Path,
    relative_path: &str,
    destination_parent: &str,
) -> Result<String, String> {
    let source = safe_project_entry(project_path, relative_path)?;
    let destination_dir = parent_directory(project_path, destination_parent)?;
    let source_canonical = fs::canonicalize(&source).map_err(|error| error.to_string())?;
    let destination_canonical =
        fs::canonicalize(&destination_dir).map_err(|error| error.to_string())?;
    if source_canonical == destination_canonical {
        return Err("不能将文件夹移动到自身".into());
    }
    if source.is_dir() && destination_canonical.starts_with(&source_canonical) {
        return Err("不能将文件夹移动到自身内部".into());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "无法移动项目根目录".to_string())?
        .to_string_lossy()
        .into_owned();
    if source
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .as_ref()
        == Some(&destination_canonical)
    {
        return Ok(relative_path.replace('\\', "/"));
    }
    let unique_name = unique_name_in(&destination_dir, &file_name);
    let destination = destination_dir.join(&unique_name);
    fs::rename(&source, &destination).map_err(|error| format!("移动失败：{error}"))?;
    let parent = destination_parent.trim().replace('\\', "/");
    if parent.is_empty() {
        Ok(unique_name)
    } else {
        Ok(format!("{parent}/{unique_name}"))
    }
}

fn parent_directory(project_path: &Path, parent_relative_path: &str) -> Result<PathBuf, String> {
    let parent_relative_path = parent_relative_path.trim();
    if parent_relative_path.is_empty() {
        return Ok(project_path.to_path_buf());
    }
    let parent = safe_project_entry(project_path, parent_relative_path)?;
    if parent.is_dir() {
        Ok(parent)
    } else {
        parent
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法在项目根目录之外创建".to_string())
    }
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "heic", "heif", "tif",
    "tiff",
];
const MAX_EDITOR_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEditorImage {
    pub markdown_path: String,
    pub absolute_path: String,
}

fn image_extension(file_name: &str) -> Option<String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(extension)
}

fn storage_image_name(file_name: &str) -> Result<String, String> {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim();
    let extension = image_extension(base).ok_or_else(|| "只能插入图片".to_string())?;
    let stem = Path::new(base)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut safe_stem = String::new();
    for character in stem.chars() {
        if character.is_alphanumeric() || character == '-' || character == '_' {
            safe_stem.push(character);
        } else if !safe_stem.ends_with('-') {
            safe_stem.push('-');
        }
    }
    let safe_stem = safe_stem.trim_matches('-');
    let safe_stem = if safe_stem.is_empty() {
        "image"
    } else {
        safe_stem
    };
    Ok(format!("{safe_stem}.{extension}"))
}

fn note_directory_depth(note_relative_path: &str) -> Result<usize, String> {
    let trimmed = note_relative_path.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(0);
    }
    let relative = Path::new(trimmed);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(component, Component::Normal(_) | Component::CurDir)
        })
    {
        return Err("笔记路径无效".into());
    }
    Ok(relative
        .parent()
        .map(|parent| parent.components().count())
        .unwrap_or(0))
}

fn markdown_asset_path(note_relative_path: &str, asset_relative_path: &str) -> Result<String, String> {
    let depth = note_directory_depth(note_relative_path)?;
    let mut relative = "../".repeat(depth);
    relative.push_str(asset_relative_path.trim_start_matches('/'));
    Ok(relative)
}

pub fn import_editor_image(
    project_path: &Path,
    source_path: Option<&Path>,
    bytes: Option<&[u8]>,
    file_name: Option<&str>,
    note_relative_path: &str,
) -> Result<ImportedEditorImage, String> {
    let (stored_name, contents) = match (source_path, bytes) {
        (Some(source), _) => {
            if !source.is_file() {
                return Err("只能插入图片文件".into());
            }
            let length = fs::metadata(source).map_err(|error| error.to_string())?.len();
            if length == 0 || length > MAX_EDITOR_IMAGE_BYTES {
                return Err("图片为空或超过 32MB".into());
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let contents = fs::read(source).map_err(|error| error.to_string())?;
            (storage_image_name(name)?, contents)
        }
        (None, Some(bytes)) => {
            if bytes.is_empty() || bytes.len() as u64 > MAX_EDITOR_IMAGE_BYTES {
                return Err("图片为空或超过 32MB".into());
            }
            (
                storage_image_name(file_name.unwrap_or("image.png"))?,
                bytes.to_vec(),
            )
        }
        (None, None) => return Err("没有可插入的图片".into()),
    };

    let assets = project_path.join(ASSETS_DIRECTORY_NAME);
    fs::create_dir_all(&assets).map_err(|error| error.to_string())?;
    let file_name = unique_image_name(&assets, &stored_name);
    let destination = assets.join(&file_name);
    fs::write(&destination, contents).map_err(|error| error.to_string())?;
    let asset_relative = format!("{ASSETS_DIRECTORY_NAME}/{file_name}");
    Ok(ImportedEditorImage {
        markdown_path: markdown_asset_path(note_relative_path, &asset_relative)?,
        absolute_path: destination.to_string_lossy().into_owned(),
    })
}

fn unique_image_name(directory: &Path, file_name: &str) -> String {
    if !directory.join(file_name).exists() {
        return file_name.to_string();
    }
    let original = Path::new(file_name);
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    for index in 2..10_000 {
        let candidate = format!("{stem}-{index}.{extension}");
        if !directory.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-new.{extension}")
}

fn unique_name_in(directory: &Path, file_name: &str) -> String {
    if !directory.join(file_name).exists() {
        return file_name.to_string();
    }
    let original = Path::new(file_name);
    let extension = original.extension().and_then(|value| value.to_str());
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let suffix = extension.map(|value| format!(".{value}")).unwrap_or_default();
    for index in 2..10_000 {
        let candidate = format!("{stem} ({index}){suffix}");
        if !directory.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-new{suffix}")
}

pub fn create_project_entry(
    project_path: &Path,
    parent_relative_path: &str,
    kind: &str,
) -> Result<CreatedWorkspaceEntry, String> {
    let kind = kind.trim();
    if kind != "file" && kind != "folder" {
        return Err("只能创建文件或文件夹".into());
    }
    let parent = parent_directory(project_path, parent_relative_path)?;
    let suggested = if kind == "folder" {
        NEW_FOLDER_NAME
    } else {
        NEW_PAGE_FILE_NAME
    };
    let title = unique_name_in(&parent, suggested);
    validate_entry_name(&title, kind == "folder")?;
    let destination = parent.join(&title);
    if destination.exists() {
        return Err(format!("同名文件已存在：{title}"));
    }
    if kind == "folder" {
        fs::create_dir(&destination).map_err(|error| format!("创建文件夹失败：{error}"))?;
    } else {
        fs::write(&destination, "").map_err(|error| format!("创建文件失败：{error}"))?;
    }
    let relative_path = destination
        .strip_prefix(project_path)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&destination).map_err(|error| error.to_string())?;
    let reserved_ids = workspace_node_ids(&loaded_workspace_nodes(project_path));
    Ok(CreatedWorkspaceEntry {
        id: unique_filesystem_node_id(&relative_path, &reserved_ids),
        title,
        kind: kind.to_string(),
        relative_path,
        file_type: (kind == "file").then(|| {
            destination
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("FILE")
                .to_uppercase()
        }),
        size: (kind == "file").then(|| display_size(metadata.len())),
        file_identity: file_identity(&metadata),
    })
}

fn safe_identifier(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("Invalid workspace node id: {id}"));
    }
    Ok(id)
}

pub fn write_atomic(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("data");
    let temporary_path = path.with_extension(format!("{extension}.tmp"));
    fs::write(&temporary_path, payload).map_err(|error| error.to_string())?;

    match fs::rename(&temporary_path, path) {
        Ok(()) => Ok(()),
        Err(first_error) if path.exists() => {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            fs::rename(&temporary_path, path)
                .map_err(|error| format!("Atomic replace failed after {first_error}: {error}"))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Writes only when the payload differs from what is already on disk, so an
/// autosave pass leaves untouched files with their original mtime.
fn write_atomic_if_changed(path: &Path, payload: &str) -> Result<(), String> {
    if fs::read_to_string(path).is_ok_and(|current| current == payload) {
        return Ok(());
    }
    write_atomic(path, payload)
}

fn normalized_markdown(text: &str) -> String {
    strip_generated_front_matter(text)
        .replace("\r\n", "\n")
        .trim_end()
        .to_string()
}

fn markdown_content_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(normalized_markdown(text).as_bytes()))
}

/// True when HyperSpace is trying to write the same markdown it last saved,
/// but the file on disk has since been changed by another editor.
fn is_stale_markdown_write(last_hash: Option<&str>, incoming: &str, on_disk: &str) -> bool {
    let Some(last_hash) = last_hash else {
        return false;
    };
    markdown_content_hash(incoming) == last_hash && markdown_content_hash(on_disk) != last_hash
}

fn file_type_label(relative_path: &str) -> String {
    Path::new(relative_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("FILE")
        .to_uppercase()
}

fn durable_node_sidecar(node: &Value) -> Value {
    let mut sidecar = Map::new();
    sidecar.insert("id".into(), Value::String(value_string(node.get("id"))));
    sidecar.insert("kind".into(), Value::String(value_string(node.get("kind"))));
    sidecar.insert(
        "parentId".into(),
        node.get("parentId").cloned().unwrap_or(Value::Null),
    );
    sidecar.insert(
        "title".into(),
        Value::String(value_string(node.get("title"))),
    );
    if let Some(path) = node
        .get("localPath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        sidecar.insert("localPath".into(), Value::String(path.to_string()));
    }
    if let Some(tags) = node.get("tagIds").and_then(Value::as_array) {
        if !tags.is_empty() {
            sidecar.insert("tagIds".into(), Value::Array(tags.clone()));
        }
    }
    if node.get("favorite").and_then(Value::as_bool) == Some(true) {
        sidecar.insert("favorite".into(), Value::Bool(true));
    }
    if let Some(color) = node
        .get("markerColor")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        sidecar.insert("markerColor".into(), Value::String(color.to_string()));
    }
    if node.get("lfsTracked").and_then(Value::as_bool) == Some(true) {
        sidecar.insert("lfsTracked".into(), Value::Bool(true));
    }
    Value::Object(sidecar)
}

fn read_json_value(path: &Path) -> Result<Value, String> {
    serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid JSON {}: {error}", path.display()))
}

fn read_optional_json(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    read_json_value(path).map(Some)
}

fn read_state_map(root: &Path) -> Result<Map<String, Value>, String> {
    let path = root.join(STATE_FILE);
    if !path.exists() {
        return Ok(Map::new());
    }
    read_json_value(&path)?
        .as_object()
        .cloned()
        .ok_or_else(|| "Workspace state must be a JSON object".to_string())
}

fn state_nodes_from(state: &Map<String, Value>) -> Map<String, Value> {
    state
        .get("nodes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn remember_local_field(nodes: &mut Map<String, Value>, id: &str, key: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    let entry = nodes
        .entry(id.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(object) = entry.as_object_mut() {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn remembered_field(
    node: &Value,
    state_nodes: &Map<String, Value>,
    id: &str,
    key: &str,
) -> Option<String> {
    if let Some(value) = node
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }
    state_nodes
        .get(id)
        .and_then(Value::as_object)
        .and_then(|entry| entry.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn copy_state_field_if_absent(state: &mut Map<String, Value>, manifest: &Value, key: &str) {
    let absent = match state.get(key) {
        Some(Value::String(value)) => value.is_empty(),
        Some(Value::Null) | None => true,
        Some(_) => false,
    };
    if absent {
        if let Some(value) = manifest.get(key) {
            state.insert(key.to_string(), value.clone());
        }
    }
}

fn write_tracked_manifest(
    root: &Path,
    node_order: Vec<Value>,
    tags: Option<&Value>,
) -> Result<(), String> {
    let mut manifest = Map::new();
    manifest.insert(
        "schemaVersion".into(),
        Value::Number(SCHEMA_VERSION.into()),
    );
    manifest.insert("nodeOrder".into(), Value::Array(node_order));
    if let Some(tags) = tags {
        manifest.insert("tags".into(), tags.clone());
    }
    write_json(&root.join(MANIFEST_FILE), &Value::Object(manifest))
}

fn write_local_state(
    root: &Path,
    selected_node_id: Option<&Value>,
    last_saved_at: Option<&Value>,
    node_order: &[String],
    state_nodes: &Map<String, Value>,
) -> Result<(), String> {
    let mut state = Map::new();
    if let Some(value) = selected_node_id {
        state.insert("selectedNodeId".into(), value.clone());
    }
    if let Some(value) = last_saved_at {
        state.insert("lastSavedAt".into(), value.clone());
    }
    let mut nodes = Map::new();
    for id in node_order {
        let Some(entry) = state_nodes.get(id).and_then(Value::as_object) else {
            continue;
        };
        let mut slim = Map::new();
        for key in ["contentHash", "fileIdentity"] {
            if let Some(value) = entry
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                slim.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
        if !slim.is_empty() {
            nodes.insert(id.clone(), Value::Object(slim));
        }
    }
    if !nodes.is_empty() {
        state.insert("nodes".into(), Value::Object(nodes));
    }
    write_json(&root.join(STATE_FILE), &Value::Object(state))
}

fn page_notes_path(project_path: &Path, id: &str) -> PathBuf {
    project_path.join("notes").join(format!("{id}.md"))
}

fn document_sidecar_path(root: &Path, id: &str) -> PathBuf {
    root.join("documents").join(format!("{id}.json"))
}

/// Moves a legacy document sidecar into the note file, then deletes the sidecar
/// once the note body is safely on disk.
fn materialize_page_markdown(project_path: &Path, id: &str, title: &str) -> Result<(), String> {
    let root = hyperspace_dir(project_path);
    let notes_path = page_notes_path(project_path, id);
    let existing = fs::read_to_string(&notes_path).unwrap_or_default();
    let file_body = strip_generated_front_matter(&existing);
    let document_path = document_sidecar_path(&root, id);
    let document = read_optional_json(&document_path)?;
    if let Some(document) = &document {
        if document.get("blocks").is_some() || document.get("editorDocument").is_some() {
            backup_legacy_file(
                &root,
                &document_path,
                &PathBuf::from("documents").join(format!("{id}.json")),
            )?;
        }
    }
    let migrated = document
        .as_ref()
        .map(document_markdown)
        .unwrap_or_default();
    let markdown = if !file_body.trim().is_empty() {
        file_body
    } else {
        migrated.clone()
    };
    if strip_generated_front_matter(&existing).trim().is_empty() && !markdown.trim().is_empty() {
        if let Some(parent) = notes_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        write_atomic(&notes_path, &markdown_file(id, title, &markdown))?;
    }
    let stored_body = fs::read_to_string(&notes_path)
        .map(|text| strip_generated_front_matter(&text))
        .unwrap_or_default();
    if document_path.exists() && (!stored_body.trim().is_empty() || migrated.trim().is_empty()) {
        fs::remove_file(&document_path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_workspace_schema(project_path: &Path) -> Result<(), String> {
    let root = hyperspace_dir(project_path);
    let manifest_path = root.join(MANIFEST_FILE);
    if !manifest_path.exists() {
        return Ok(());
    }
    let manifest = read_json_value(&manifest_path)?;
    let version = manifest
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    let mut state = read_state_map(&root)?;
    for key in ["selectedNodeId", "lastSavedAt"] {
        copy_state_field_if_absent(&mut state, &manifest, key);
    }
    let mut state_nodes = state_nodes_from(&state);
    let node_order = manifest
        .get("nodeOrder")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for id_value in &node_order {
        let Some(id) = id_value.as_str() else {
            continue;
        };
        safe_identifier(id)?;
        let node_path = root.join("nodes").join(format!("{id}.json"));
        if !node_path.exists() {
            continue;
        }
        let node = read_json_value(&node_path)?;
        if let Some(hash) = node.get("contentHash").and_then(Value::as_str) {
            remember_local_field(&mut state_nodes, id, "contentHash", hash);
        }
        if let Some(identity) = node.get("fileIdentity").and_then(Value::as_str) {
            remember_local_field(&mut state_nodes, id, "fileIdentity", identity);
        }
        if node.get("kind").and_then(Value::as_str) == Some("page") {
            materialize_page_markdown(project_path, id, &value_string(node.get("title")))?;
        }
        write_json(&node_path, &durable_node_sidecar(&node))?;
    }

    let order_ids = node_order
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    write_local_state(
        &root,
        state.get("selectedNodeId"),
        state.get("lastSavedAt"),
        &order_ids,
        &state_nodes,
    )?;
    write_tracked_manifest(&root, node_order, manifest.get("tags"))
}

fn overlay_local_node_state(node: &mut Value, state_nodes: &Map<String, Value>) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    let Some(id) = object.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    let Some(entry) = state_nodes.get(&id).and_then(Value::as_object) else {
        return;
    };
    for key in ["contentHash", "fileIdentity"] {
        if let Some(value) = entry
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            object.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
}

fn apply_derived_file_fields(project_path: &Path, node: &mut Value) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let relative = if kind == "page" {
        format!("notes/{id}.md")
    } else {
        object
            .get("localPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    if relative.is_empty() {
        return;
    }
    if kind == "file" {
        object.insert(
            "fileType".into(),
            Value::String(file_type_label(&relative)),
        );
    }
    let Ok(metadata) = fs::metadata(project_path.join(&relative)) else {
        return;
    };
    object.insert(
        "updatedAt".into(),
        Value::String(display_modified(&metadata)),
    );
    if kind == "file" {
        object.insert(
            "size".into(),
            Value::String(display_size(metadata.len())),
        );
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_atomic_if_changed(path, &format!("{payload}\n"))
}

fn backup_legacy_file(root: &Path, source: &Path, relative_name: &Path) -> Result<(), String> {
    let destination = root.join(VDITOR_MIGRATION_DIR).join(relative_name);
    if destination.exists() {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, &destination)
        .map(|_| ())
        .map_err(|error| format!("Failed to back up {}: {error}", source.display()))
}

fn plain_text(value: &Value, output: &mut String) {
    match value {
        Value::String(text) => {
            if !output.is_empty() {
                output.push(' ');
            }
            output.push_str(text);
        }
        Value::Array(values) => {
            for value in values {
                plain_text(value, output);
            }
        }
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                if !output.is_empty() {
                    output.push(' ');
                }
                output.push_str(text);
            } else {
                for key in ["content", "children"] {
                    if let Some(value) = object.get(key) {
                        plain_text(value, output);
                    }
                }
            }
        }
        _ => {}
    }
}

fn legacy_blocks_to_markdown(blocks: &Value) -> String {
    let mut lines = Vec::new();
    for block in blocks.as_array().into_iter().flatten() {
        let kind = value_string(block.get("kind"));
        let content = value_string(block.get("content"));
        let line = match kind.as_str() {
            "heading1" => format!("# {content}"),
            "heading" => format!("## {content}"),
            "heading3" => format!("### {content}"),
            "bullet" => format!("- {content}"),
            "ordered" => format!("1. {content}"),
            "quote" | "callout" => format!("> {content}"),
            "code" => format!(
                "```{}\n{}\n```",
                value_string(block.get("language")),
                content
            ),
            "folder" | "file" => format!(
                "```hyperspace\n{}\n```",
                json!({
                    "version": 1,
                    "kind": kind,
                    "targetNodeId": value_string(block.get("targetNodeId")),
                    "blockId": value_string(block.get("id")),
                })
            ),
            _ => content,
        };
        lines.push(line);
    }
    lines.join("\n\n")
}

fn note_body(workspace: &Value, node_id: &str) -> String {
    if let Some(markdown) = workspace
        .get("noteMarkdown")
        .and_then(|value| value.get(node_id))
        .and_then(Value::as_str)
    {
        if !markdown.trim().is_empty() {
            return markdown.trim().to_string();
        }
    }

    if let Some(document) = workspace
        .get("editorDocuments")
        .and_then(|value| value.get(node_id))
    {
        let mut text = String::new();
        plain_text(document, &mut text);
        return text;
    }

    workspace
        .get("blocks")
        .and_then(|value| value.get(node_id))
        .map(legacy_blocks_to_markdown)
        .unwrap_or_default()
}

fn markdown_file(node_id: &str, title: &str, body: &str) -> String {
    let yaml_title = serde_json::to_string(title).unwrap_or_else(|_| "\"Untitled\"".into());
    format!(
        "---\nid: {node_id}\ntitle: {yaml_title}\nschemaVersion: {NOTE_FRONT_MATTER_VERSION}\n---\n\n{}\n",
        body.trim_end()
    )
}

fn remove_stale_files(
    directory: &Path,
    valid_ids: &HashSet<String>,
    extension: &str,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some(extension) {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !valid_ids.contains(id) {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn remove_stale_generated_notes(
    directory: &Path,
    valid_ids: &HashSet<String>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if valid_ids.contains(id) {
            continue;
        }
        let header = fs::read_to_string(&path)
            .map_err(|error| error.to_string())?
            .lines()
            .take(5)
            .collect::<Vec<_>>()
            .join("\n");
        if header.starts_with("---\n") && header.lines().any(|line| line == format!("id: {id}")) {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownNoteSave {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub relative_path: String,
    pub body: String,
}

fn is_markdown_relative_path(relative_path: &str) -> bool {
    let lower = relative_path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn writable_project_file(project_path: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Invalid project file path: {relative_path}"));
    }
    let target = project_path.join(relative);
    let canonical_project = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let canonical_parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
        if !canonical_parent.starts_with(&canonical_project) {
            return Err(format!(
                "Project file is outside the workspace: {relative_path}"
            ));
        }
    }
    Ok(target)
}

fn remembered_content_hash(state_nodes: &Map<String, Value>, id: &str) -> Option<String> {
    state_nodes
        .get(id)
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("contentHash"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Writes one page note. `None` means the file was left untouched.
fn save_page_markdown(
    project_path: &Path,
    id: &str,
    title: &str,
    body: &str,
    content_hash: Option<&str>,
) -> Result<Option<String>, String> {
    let notes_dir = project_path.join("notes");
    fs::create_dir_all(&notes_dir).map_err(|error| error.to_string())?;
    let notes_path = notes_dir.join(format!("{id}.md"));
    let existing = fs::read_to_string(&notes_path).unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        let stripped = strip_generated_front_matter(&existing);
        if !stripped.trim().is_empty() {
            return Ok(None);
        }
    }
    let payload = markdown_file(id, title, body);
    if is_stale_markdown_write(content_hash, &payload, &existing) {
        return Ok(None);
    }
    write_atomic_if_changed(&notes_path, &payload)?;
    Ok(Some(body.to_string()))
}

/// Writes one markdown file. `None` means the file was left untouched.
fn save_file_markdown(
    project_path: &Path,
    relative_path: &str,
    body: &str,
    content_hash: Option<&str>,
) -> Result<Option<String>, String> {
    let source_path = writable_project_file(project_path, relative_path)?;
    let on_disk = fs::read_to_string(&source_path).unwrap_or_default();
    let body = body.trim();
    if body.is_empty() && !on_disk.trim().is_empty() {
        return Ok(None);
    }
    let payload = if body.is_empty() {
        String::new()
    } else if on_disk.is_empty() || on_disk.ends_with('\n') {
        format!("{body}\n")
    } else {
        body.to_string()
    };
    if is_stale_markdown_write(content_hash, &payload, &on_disk) {
        return Ok(None);
    }
    write_atomic_if_changed(&source_path, &payload)?;
    Ok(Some(body.to_string()))
}

fn read_search_index(root: &Path) -> Result<Option<Vec<SearchDocument>>, String> {
    let path = root.join(SEARCH_INDEX_FILE);
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_str(&fs::read_to_string(&path).map_err(|error| error.to_string())?)
        .map(Some)
        .map_err(|error| format!("Invalid search index: {error}"))
}

fn patch_search_document(
    documents: &mut Vec<SearchDocument>,
    id: &str,
    title: &str,
    kind: &str,
    path: &str,
    content: &str,
) {
    if let Some(document) = documents
        .iter_mut()
        .find(|document| document.node_id == id)
    {
        document.title = title.to_string();
        document.kind = kind.to_string();
        document.path = path.to_string();
        document.content = content.to_string();
        return;
    }
    documents.push(SearchDocument {
        node_id: id.to_string(),
        title: title.to_string(),
        kind: kind.to_string(),
        file_type: (kind == "file").then(|| file_type_label(path)),
        path: path.to_string(),
        tags: Vec::new(),
        content: content.to_string(),
        updated_at: String::new(),
    });
}

/// Persists only the notes that changed. Skips sidecars, the manifest, and a
/// full workspace rewrite so typing does not stall the window.
pub fn save_markdown_notes(
    project_path: &Path,
    notes: &[MarkdownNoteSave],
    selected_node_id: Option<&str>,
) -> Result<(), String> {
    if notes.is_empty() && selected_node_id.unwrap_or("").is_empty() {
        return Ok(());
    }
    let root = hyperspace_dir(project_path);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut state = read_state_map(&root)?;
    if let Some(id) = selected_node_id.filter(|id| !id.is_empty()) {
        safe_identifier(id)?;
        state.insert("selectedNodeId".into(), Value::String(id.to_string()));
    }
    if notes.is_empty() {
        write_json(&root.join(STATE_FILE), &Value::Object(state))?;
        return Ok(());
    }
    let mut state_nodes = state_nodes_from(&state);
    let mut search_index = read_search_index(&root)?;

    for note in notes {
        let id = safe_identifier(&note.id)?.to_string();
        let previous_hash = remembered_content_hash(&state_nodes, &id);
        let (relative_path, saved) = if note.kind == "page" {
            (
                format!("notes/{id}.md"),
                save_page_markdown(
                    project_path,
                    &id,
                    &note.title,
                    &note.body,
                    previous_hash.as_deref(),
                )?,
            )
        } else if note.kind == "file" && is_markdown_relative_path(&note.relative_path) {
            (
                note.relative_path.clone(),
                save_file_markdown(
                    project_path,
                    &note.relative_path,
                    &note.body,
                    previous_hash.as_deref(),
                )?,
            )
        } else {
            return Err(format!("无法自动保存该节点：{id}"));
        };
        let Some(content) = saved else {
            continue;
        };
        let hash = markdown_content_hash(&content);
        remember_local_field(&mut state_nodes, &id, "contentHash", &hash);
        if let Some(documents) = search_index.as_mut() {
            patch_search_document(documents, &id, &note.title, &note.kind, &relative_path, &content);
        }
    }

    state.insert("nodes".into(), Value::Object(state_nodes));
    write_json(&root.join(STATE_FILE), &Value::Object(state))?;
    if let Some(documents) = search_index {
        write_json(
            &root.join(SEARCH_INDEX_FILE),
            &serde_json::to_value(documents).map_err(|error| error.to_string())?,
        )?;
    }
    Ok(())
}

pub fn save_project_workspace(project_path: &Path, payload: &str) -> Result<(), String> {
    migrate_workspace_schema(project_path)?;
    let workspace: Value = serde_json::from_str(payload)
        .map_err(|error| format!("Workspace payload is not valid JSON: {error}"))?;
    let object = workspace
        .as_object()
        .ok_or_else(|| "Workspace payload must be a JSON object".to_string())?;
    let nodes = object
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Workspace nodes are missing".to_string())?;

    let root = hyperspace_dir(project_path);
    let nodes_dir = root.join("nodes");
    let documents_dir = root.join("documents");
    let notes_dir = project_path.join("notes");
    fs::create_dir_all(&nodes_dir).map_err(|error| error.to_string())?;
    let mut state_nodes = state_nodes_from(&read_state_map(&root)?);

    let tags_by_id: HashMap<String, String> = object
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tag| {
            Some((
                tag.get("id")?.as_str()?.to_string(),
                tag.get("name")?.as_str()?.to_string(),
            ))
        })
        .collect();

    let mut node_order = Vec::new();
    let mut valid_node_ids = HashSet::new();
    let mut valid_page_ids = HashSet::new();
    let mut search_documents = Vec::new();

    for node in nodes {
        let id = value_string(node.get("id"));
        safe_identifier(&id)?;
        let title = value_string(node.get("title"));
        let kind = value_string(node.get("kind"));
        node_order.push(Value::String(id.clone()));
        valid_node_ids.insert(id.clone());

        let path = if kind == "page" {
            format!("notes/{id}.md")
        } else {
            node.get("localPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let tag_names = node
            .get("tagIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|tag_id| tags_by_id.get(tag_id).cloned())
            .collect::<Vec<_>>();

        let mut content_hash = remembered_field(node, &state_nodes, &id, "contentHash");
        let is_markdown_file = is_markdown_file_node(node);
        let content = if kind == "page" {
            valid_page_ids.insert(id.clone());
            fs::create_dir_all(&notes_dir).map_err(|error| error.to_string())?;
            let notes_path = notes_dir.join(format!("{id}.md"));
            let existing = fs::read_to_string(&notes_path).unwrap_or_default();
            let mut body = note_body(&workspace, &id);
            if body.trim().is_empty() {
                let stripped = strip_generated_front_matter(&existing);
                if !stripped.trim().is_empty() {
                    body = stripped;
                }
            }
            let payload = markdown_file(&id, &title, &body);
            let stale = is_stale_markdown_write(content_hash.as_deref(), &payload, &existing);
            if !stale {
                write_atomic_if_changed(&notes_path, &payload)?;
            }
            materialize_page_markdown(project_path, &id, &title)?;
            let stored = fs::read_to_string(&notes_path).unwrap_or_default();
            if !stale {
                content_hash = Some(markdown_content_hash(&stored));
            }
            strip_generated_front_matter(&stored)
        } else if is_markdown_file {
            let source_path = project_file(project_path, &path)?;
            let on_disk = fs::read_to_string(&source_path).unwrap_or_default();
            let body = note_body(&workspace, &id);
            // An empty buffer means the note was never loaded into the editor this
            // session, so it must never truncate a file that still has content.
            if body.trim().is_empty() && !on_disk.trim().is_empty() {
                strip_generated_front_matter(&on_disk)
            } else {
                // note_body trims, so the trailing newline has to come back or every
                // saved file keeps a one-byte diff and never compares equal to disk.
                // Match whatever the file already used; only new files get one imposed.
                let payload = if body.is_empty() {
                    String::new()
                } else if on_disk.is_empty() || on_disk.ends_with('\n') {
                    format!("{body}\n")
                } else {
                    body.clone()
                };
                if is_stale_markdown_write(content_hash.as_deref(), &payload, &on_disk) {
                    strip_generated_front_matter(&on_disk)
                } else {
                    write_atomic_if_changed(&source_path, &payload)?;
                    content_hash = Some(markdown_content_hash(&payload));
                    body
                }
            }
        } else {
            String::new()
        };
        if let Some(hash) = content_hash.as_deref() {
            remember_local_field(&mut state_nodes, &id, "contentHash", hash);
        }

        if kind != "page" && !path.is_empty() {
            if let Ok(source_path) = safe_project_entry(project_path, &path) {
                let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
                if let Some(identity) = file_identity(&metadata) {
                    remember_local_field(&mut state_nodes, &id, "fileIdentity", &identity);
                }
            }
        }
        write_json(&nodes_dir.join(format!("{id}.json")), &durable_node_sidecar(node))?;

        search_documents.push(SearchDocument {
            node_id: id,
            title,
            kind,
            file_type: node
                .get("fileType")
                .and_then(Value::as_str)
                .map(str::to_string),
            path,
            tags: tag_names,
            content,
            updated_at: value_string(node.get("updatedAt")),
        });
    }

    remove_stale_files(&nodes_dir, &valid_node_ids, "json")?;
    remove_stale_files(&documents_dir, &valid_page_ids, "json")?;
    if notes_dir.exists() {
        remove_stale_generated_notes(&notes_dir, &valid_page_ids)?;
    }

    let order_ids = node_order
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    write_tracked_manifest(&root, node_order, object.get("tags"))?;
    write_local_state(
        &root,
        object.get("selectedNodeId"),
        object.get("lastSavedAt"),
        &order_ids,
        &state_nodes,
    )?;
    write_json(
        &root.join(SEARCH_INDEX_FILE),
        &serde_json::to_value(search_documents).map_err(|error| error.to_string())?,
    )?;
    Ok(())
}

pub fn load_project_workspace(project_path: &Path) -> Result<Option<String>, String> {
    let root = hyperspace_dir(project_path);
    let manifest_path = root.join(MANIFEST_FILE);
    if !manifest_path.exists() {
        let legacy_path = root.join(LEGACY_WORKSPACE_FILE);
        if !legacy_path.exists() {
            return Ok(None);
        }
        backup_legacy_file(&root, &legacy_path, Path::new(LEGACY_WORKSPACE_FILE))?;
        return fs::read_to_string(legacy_path)
            .map(Some)
            .map_err(|error| error.to_string());
    }

    migrate_workspace_schema(project_path)?;
    let manifest = read_json_value(&manifest_path)?;
    let state = read_state_map(&root)?;
    let state_nodes = state_nodes_from(&state);
    let mut workspace = Map::new();
    if let Some(tags) = manifest.get("tags") {
        workspace.insert("tags".into(), tags.clone());
    }
    for key in ["selectedNodeId", "lastSavedAt"] {
        if let Some(value) = state.get(key).or_else(|| manifest.get(key)) {
            workspace.insert(key.into(), value.clone());
        }
    }

    let mut nodes = Vec::new();
    let mut note_markdown = Map::new();
    for id in manifest
        .get("nodeOrder")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        safe_identifier(id)?;
        let node_path = root.join("nodes").join(format!("{id}.json"));
        let mut node = read_json_value(&node_path)
            .map_err(|error| format!("Failed to read {}: {error}", node_path.display()))?;
        overlay_local_node_state(&mut node, &state_nodes);
        apply_derived_file_fields(project_path, &mut node);
        let is_page = node.get("kind").and_then(Value::as_str) == Some("page");
        let title = value_string(node.get("title"));
        let markdown_path = (!is_page && is_markdown_file_node(&node))
            .then(|| {
                node.get("localPath")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .flatten();
        nodes.push(node);

        if is_page {
            materialize_page_markdown(project_path, id, &title)?;
            let markdown = read_markdown_file(project_path, &format!("notes/{id}.md"))
                .map(|text| strip_generated_front_matter(&text))
                .unwrap_or_default();
            note_markdown.insert(id.to_string(), Value::String(markdown));
        } else if let Some(relative_path) = markdown_path {
            if let Some(markdown) = read_markdown_file(project_path, &relative_path) {
                note_markdown.insert(
                    id.to_string(),
                    Value::String(strip_generated_front_matter(&markdown)),
                );
            }
        }
    }

    workspace.insert("nodes".into(), Value::Array(nodes));
    workspace.insert("noteMarkdown".into(), Value::Object(note_markdown));
    serde_json::to_string(&Value::Object(workspace))
        .map(Some)
        .map_err(|error| error.to_string())
}

fn first_chars(text: &str, max_chars: usize) -> String {
    let snippet = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        format!("{snippet}…")
    } else {
        snippet
    }
}

pub fn search_project(
    project_path: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let index_path = hyperspace_dir(project_path).join(SEARCH_INDEX_FILE);
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let documents: Vec<SearchDocument> =
        serde_json::from_str(&fs::read_to_string(index_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid search index: {error}"))?;

    let terms = query.split_whitespace().collect::<Vec<_>>();
    let mut results = documents
        .into_iter()
        .filter_map(|document| {
            let title = document.title.to_lowercase();
            let path = document.path.to_lowercase();
            let tags = document.tags.join(" ").to_lowercase();
            let content = document.content.to_lowercase();
            let matches_all = terms.iter().all(|term| {
                title.contains(term)
                    || path.contains(term)
                    || tags.contains(term)
                    || content.contains(term)
            });
            if !matches_all {
                return None;
            }
            let score = if title == query {
                100
            } else if title.starts_with(&query) {
                80
            } else if title.contains(&query) {
                60
            } else if tags.contains(&query) || path.contains(&query) {
                40
            } else {
                20
            };
            Some(SearchResult {
                node_id: document.node_id,
                title: document.title,
                kind: document.kind,
                file_type: document.file_type,
                path: document.path,
                snippet: first_chars(&document.content.replace('\n', " "), 120),
                score,
            })
        })
        .collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.title.cmp(&right.title))
    });
    results.truncate(limit.clamp(1, 100));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("hyperspace-{name}-{unique}"))
    }

    #[test]
    fn split_workspace_round_trips_and_searches_note_body() {
        let project = test_directory("workspace");
        fs::create_dir_all(&project).expect("create temp project");
        let payload = json!({
          "selectedNodeId": "page-one",
          "tags": [{"id": "tag-one", "name": "重点"}],
          "nodes": [
            {"id": "page-one", "parentId": null, "kind": "page", "title": "产品探索", "updatedAt": "刚刚", "tagIds": ["tag-one"]},
            {"id": "file-one", "parentId": null, "kind": "file", "title": "访谈.pdf", "fileType": "PDF", "updatedAt": "刚刚", "localPath": "attachments/访谈.pdf"}
          ],
          "blocks": {"page-one": []},
          "editorDocuments": {"page-one": [{"id": "block-one", "type": "paragraph", "content": [{"type": "text", "text": "离线优先的正文"}]}]},
          "noteMarkdown": {"page-one": "离线优先的正文"}
        });

        save_project_workspace(&project, &payload.to_string()).expect("save split workspace");
        assert!(project.join("notes/page-one.md").exists());
        assert!(project.join(".hyperspace/nodes/page-one.json").exists());
        fs::write(project.join("notes/user-readme.md"), "# 用户自己的文件\n")
            .expect("write user markdown");
        save_project_workspace(&project, &payload.to_string()).expect("save again");
        assert!(project.join("notes/user-readme.md").exists());

        let loaded = load_project_workspace(&project)
            .expect("load split workspace")
            .expect("workspace exists");
        let loaded: Value = serde_json::from_str(&loaded).expect("valid workspace JSON");
        assert_eq!(loaded["nodes"].as_array().map(Vec::len), Some(2));
        assert_eq!(loaded["selectedNodeId"], "page-one");
        assert_eq!(loaded["noteMarkdown"]["page-one"], "离线优先的正文");
        assert_eq!(loaded["tags"][0]["name"], "重点");
        assert!(loaded.get("blocks").is_none());
        assert!(loaded.get("editorDocuments").is_none());
        assert!(!project.join(".hyperspace/documents/page-one.json").exists());

        let sidecar: Value = serde_json::from_str(
            &fs::read_to_string(project.join(".hyperspace/nodes/page-one.json")).expect("read sidecar"),
        )
        .expect("valid sidecar");
        assert_eq!(sidecar["id"], "page-one");
        assert_eq!(sidecar["title"], "产品探索");
        assert_eq!(sidecar["tagIds"][0], "tag-one");
        assert!(sidecar.get("updatedAt").is_none());
        assert!(sidecar.get("contentHash").is_none());
        assert!(sidecar.get("storagePath").is_none());
        assert!(sidecar.get("fileIdentity").is_none());

        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(project.join(".hyperspace/manifest.json")).expect("read manifest"),
        )
        .expect("valid manifest");
        assert_eq!(manifest["schemaVersion"], 3);
        assert!(manifest.get("selectedNodeId").is_none());
        assert!(manifest.get("lastSavedAt").is_none());
        assert_eq!(manifest["tags"][0]["name"], "重点");

        let state: Value = serde_json::from_str(
            &fs::read_to_string(project.join(".hyperspace/state.json")).expect("read state"),
        )
        .expect("valid state");
        assert_eq!(state["selectedNodeId"], "page-one");
        assert!(!state["nodes"]["page-one"]["contentHash"]
            .as_str()
            .unwrap_or_default()
            .is_empty());

        let results = search_project(&project, "离线优先", 12).expect("search workspace");
        assert_eq!(
            results.first().map(|result| result.node_id.as_str()),
            Some("page-one")
        );
        let file_results = search_project(&project, "访谈", 12).expect("search filename");
        assert_eq!(
            file_results.first().map(|result| result.node_id.as_str()),
            Some("file-one")
        );

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn autosave_and_note_edits_leave_tracked_metadata_unchanged() {
        let project = test_directory("stable-metadata");
        fs::create_dir_all(&project).expect("create temp project");
        let payload = json!({
          "selectedNodeId": "page-one",
          "lastSavedAt": "2026-10-19T00:00:00Z",
          "tags": [{"id": "tag-one", "name": "重点"}],
          "nodes": [
            {"id": "page-one", "parentId": null, "kind": "page", "title": "产品探索", "updatedAt": "刚刚", "tagIds": ["tag-one"]},
            {"id": "file-one", "parentId": null, "kind": "file", "title": "访谈.pdf", "fileType": "PDF", "updatedAt": "刚刚", "localPath": "attachments/访谈.pdf"}
          ],
          "noteMarkdown": {"page-one": "第一版正文"}
        });
        save_project_workspace(&project, &payload.to_string()).expect("initial save");

        let manifest_path = project.join(".hyperspace/manifest.json");
        let node_path = project.join(".hyperspace/nodes/page-one.json");
        let manifest_bytes = fs::read_to_string(&manifest_path).expect("read manifest");
        let node_bytes = fs::read_to_string(&node_path).expect("read node");
        let state_path = project.join(".hyperspace/state.json");
        let original_state: Value =
            serde_json::from_str(&fs::read_to_string(&state_path).expect("read state"))
                .expect("valid state");

        let mut session_only = payload.clone();
        session_only["selectedNodeId"] = json!("file-one");
        session_only["lastSavedAt"] = json!("2026-10-19T01:00:00Z");
        session_only["nodes"][0]["updatedAt"] = json!("5 分钟前");
        save_project_workspace(&project, &session_only.to_string()).expect("session save");
        assert_eq!(
            fs::read_to_string(&manifest_path).expect("reread manifest"),
            manifest_bytes
        );
        assert_eq!(fs::read_to_string(&node_path).expect("reread node"), node_bytes);
        let state: Value =
            serde_json::from_str(&fs::read_to_string(&state_path).expect("reread state"))
                .expect("valid state");
        assert_eq!(state["selectedNodeId"], "file-one");
        assert_eq!(state["lastSavedAt"], "2026-10-19T01:00:00Z");

        let mut edited = session_only;
        edited["noteMarkdown"]["page-one"] = json!("改过的正文");
        save_project_workspace(&project, &edited.to_string()).expect("edit note");
        assert_eq!(
            fs::read_to_string(&manifest_path).expect("manifest after edit"),
            manifest_bytes
        );
        assert_eq!(
            fs::read_to_string(&node_path).expect("node after edit"),
            node_bytes
        );
        assert!(fs::read_to_string(project.join("notes/page-one.md"))
            .expect("read note")
            .contains("改过的正文"));
        let edited_state: Value =
            serde_json::from_str(&fs::read_to_string(&state_path).expect("state after edit"))
                .expect("valid edited state");
        assert_ne!(
            edited_state["nodes"]["page-one"]["contentHash"],
            original_state["nodes"]["page-one"]["contentHash"]
        );
        assert!(!project.join(".hyperspace/documents/page-one.json").exists());

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn markdown_autosave_writes_only_the_dirty_note() {
        let project = test_directory("incremental-note");
        fs::create_dir_all(&project).expect("create temp project");
        let payload = json!({
          "selectedNodeId": "page-one",
          "lastSavedAt": "2026-10-19T00:00:00Z",
          "tags": [{"id": "tag-one", "name": "重点"}],
          "nodes": [
            {"id": "page-one", "parentId": null, "kind": "page", "title": "产品探索", "updatedAt": "刚刚"},
            {"id": "page-two", "parentId": null, "kind": "page", "title": "另一页", "updatedAt": "刚刚"}
          ],
          "noteMarkdown": {"page-one": "第一版正文", "page-two": "保持不动"}
        });
        save_project_workspace(&project, &payload.to_string()).expect("initial save");

        let untouched = project.join("notes/page-two.md");
        let sidecar = project.join(".hyperspace/nodes/page-one.json");
        let manifest = project.join(".hyperspace/manifest.json");
        let untouched_bytes = fs::read(&untouched).expect("read untouched");
        let sidecar_bytes = fs::read(&sidecar).expect("read sidecar");
        let manifest_bytes = fs::read(&manifest).expect("read manifest");
        let state_before: Value = serde_json::from_str(
            &fs::read_to_string(project.join(".hyperspace/state.json")).expect("read state"),
        )
        .expect("valid state");

        save_markdown_notes(
            &project,
            &[MarkdownNoteSave {
                id: "page-one".into(),
                kind: "page".into(),
                title: "产品探索".into(),
                relative_path: String::new(),
                body: "改过的正文".into(),
            }],
            None,
        )
        .expect("incremental save");

        let saved = fs::read_to_string(project.join("notes/page-one.md")).expect("read edited");
        assert!(saved.contains("改过的正文"));
        assert_eq!(fs::read(&untouched).expect("reread untouched"), untouched_bytes);
        assert_eq!(fs::read(&sidecar).expect("reread sidecar"), sidecar_bytes);
        assert_eq!(fs::read(&manifest).expect("reread manifest"), manifest_bytes);
        let state_after: Value = serde_json::from_str(
            &fs::read_to_string(project.join(".hyperspace/state.json")).expect("reread state"),
        )
        .expect("valid state");
        assert_eq!(state_after["selectedNodeId"], "page-one");
        assert_ne!(
            state_after["nodes"]["page-one"]["contentHash"],
            state_before["nodes"]["page-one"]["contentHash"]
        );
        assert_eq!(
            state_after["nodes"]["page-two"]["contentHash"],
            state_before["nodes"]["page-two"]["contentHash"]
        );
        let results = search_project(&project, "改过的正文", 12).expect("search edited note");
        assert_eq!(
            results.first().map(|result| result.node_id.as_str()),
            Some("page-one")
        );

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn schema_v2_local_fields_move_into_state_json() {
        let project = test_directory("schema-v2");
        let root = project.join(PROJECT_DIR_NAME);
        fs::create_dir_all(root.join("nodes")).expect("create nodes");
        write_json(
            &root.join(MANIFEST_FILE),
            &json!({
                "schemaVersion": 2,
                "nodeOrder": ["page-one", "file-one"],
                "selectedNodeId": "page-one",
                "lastSavedAt": "2026-10-18T00:00:00Z",
                "tags": [{"id": "tag-one", "name": "重点"}]
            }),
        )
        .expect("write manifest");
        write_json(
            &root.join("nodes/page-one.json"),
            &json!({
                "id": "page-one",
                "parentId": null,
                "kind": "page",
                "title": "产品探索",
                "updatedAt": "刚刚",
                "contentHash": "abc123",
                "storagePath": "notes/page-one.md"
            }),
        )
        .expect("write page");
        write_atomic(
            &project.join("notes/page-one.md"),
            "---\nid: page-one\ntitle: \"产品探索\"\nschemaVersion: 2\n---\n\n正文\n",
        )
        .expect("write note");
        write_json(
            &root.join("nodes/file-one.json"),
            &json!({
                "id": "file-one",
                "parentId": null,
                "kind": "file",
                "title": "访谈.pdf",
                "localPath": "attachments/访谈.pdf",
                "fileType": "PDF",
                "size": "2.4 MB",
                "updatedAt": "刚刚",
                "fileIdentity": "1:2",
                "markerColor": "purple"
            }),
        )
        .expect("write file");

        let loaded = load_project_workspace(&project)
            .expect("migrate")
            .expect("workspace");
        let loaded: Value = serde_json::from_str(&loaded).expect("valid workspace");
        assert_eq!(loaded["selectedNodeId"], "page-one");
        assert_eq!(loaded["lastSavedAt"], "2026-10-18T00:00:00Z");
        assert_eq!(loaded["noteMarkdown"]["page-one"], "正文");
        assert_eq!(loaded["nodes"][0]["contentHash"], "abc123");
        assert_eq!(loaded["nodes"][1]["fileIdentity"], "1:2");
        assert_eq!(loaded["nodes"][1]["markerColor"], "purple");
        assert_eq!(loaded["nodes"][1]["fileType"], "PDF");

        let page: Value = serde_json::from_str(
            &fs::read_to_string(root.join("nodes/page-one.json")).expect("read page"),
        )
        .expect("valid page");
        assert!(page.get("contentHash").is_none());
        assert!(page.get("updatedAt").is_none());
        assert!(page.get("storagePath").is_none());
        let file: Value = serde_json::from_str(
            &fs::read_to_string(root.join("nodes/file-one.json")).expect("read file"),
        )
        .expect("valid file");
        assert_eq!(file["markerColor"], "purple");
        assert!(file.get("fileIdentity").is_none());
        assert!(file.get("fileType").is_none());
        assert!(file.get("size").is_none());
        assert!(file.get("updatedAt").is_none());

        let state: Value =
            serde_json::from_str(&fs::read_to_string(root.join(STATE_FILE)).expect("read state"))
                .expect("valid state");
        assert_eq!(state["selectedNodeId"], "page-one");
        assert_eq!(state["lastSavedAt"], "2026-10-18T00:00:00Z");
        assert_eq!(state["nodes"]["page-one"]["contentHash"], "abc123");
        assert_eq!(state["nodes"]["file-one"]["fileIdentity"], "1:2");

        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(root.join(MANIFEST_FILE)).expect("read manifest"),
        )
        .expect("valid manifest");
        assert_eq!(manifest["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(manifest["tags"][0]["name"], "重点");
        assert!(manifest.get("selectedNodeId").is_none());
        assert!(manifest.get("lastSavedAt").is_none());

        let manifest_after_migration =
            fs::read_to_string(root.join(MANIFEST_FILE)).expect("manifest after migration");
        let node_after_migration =
            fs::read_to_string(root.join("nodes/page-one.json")).expect("node after migration");
        load_project_workspace(&project)
            .expect("second load")
            .expect("still loads");
        assert_eq!(
            fs::read_to_string(root.join(MANIFEST_FILE)).expect("manifest after second load"),
            manifest_after_migration
        );
        assert_eq!(
            fs::read_to_string(root.join("nodes/page-one.json")).expect("node after second load"),
            node_after_migration
        );

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn loading_legacy_document_backs_it_up_before_cleanup() {
        let project = test_directory("vditor-migration");
        let root = project.join(PROJECT_DIR_NAME);
        fs::create_dir_all(root.join("nodes")).expect("create nodes");
        fs::create_dir_all(root.join("documents")).expect("create documents");
        write_json(
            &root.join(MANIFEST_FILE),
            &json!({"schemaVersion": 2, "nodeOrder": ["page-one"], "selectedNodeId": "page-one"}),
        )
        .expect("write manifest");
        write_json(
            &root.join("nodes/page-one.json"),
            &json!({"id": "page-one", "parentId": null, "kind": "page", "title": "Legacy", "updatedAt": "刚刚"}),
        )
        .expect("write node");
        write_json(
            &root.join("documents/page-one.json"),
            &json!({"blocks": [], "editorDocument": [{"type": "paragraph"}], "markdown": "legacy body"}),
        )
        .expect("write legacy document");

        let loaded = load_project_workspace(&project)
            .expect("load legacy project")
            .expect("workspace");
        let loaded: Value = serde_json::from_str(&loaded).expect("valid workspace");
        assert_eq!(loaded["noteMarkdown"]["page-one"], "legacy body");
        assert_eq!(loaded["selectedNodeId"], "page-one");
        assert!(root
            .join("migrations/pre-vditor/documents/page-one.json")
            .exists());
        assert!(!root.join("documents/page-one.json").exists());
        let note = fs::read_to_string(project.join("notes/page-one.md")).expect("read note");
        assert!(note.contains("legacy body"));
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(root.join(MANIFEST_FILE)).expect("read manifest"),
        )
        .expect("valid manifest");
        assert_eq!(manifest["schemaVersion"], SCHEMA_VERSION);
        assert!(manifest.get("selectedNodeId").is_none());
        let sidecar: Value = serde_json::from_str(
            &fs::read_to_string(root.join("nodes/page-one.json")).expect("read sidecar"),
        )
        .expect("valid sidecar");
        assert!(sidecar.get("updatedAt").is_none());

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn loading_legacy_document_converts_blocks_when_markdown_is_empty() {
        let project = test_directory("vditor-empty-markdown");
        let root = project.join(PROJECT_DIR_NAME);
        fs::create_dir_all(root.join("nodes")).expect("create nodes");
        fs::create_dir_all(root.join("documents")).expect("create documents");
        write_json(
            &root.join(MANIFEST_FILE),
            &json!({"schemaVersion": 2, "nodeOrder": ["page-one"], "selectedNodeId": "page-one"}),
        )
        .expect("write manifest");
        write_json(
            &root.join("nodes/page-one.json"),
            &json!({"id": "page-one", "parentId": null, "kind": "page", "title": "产品探索", "updatedAt": "刚刚"}),
        )
        .expect("write node");
        write_json(
            &root.join("documents/page-one.json"),
            &json!({
                "blocks": [
                    {"id": "b1", "kind": "text", "content": "正文第一段"},
                    {"id": "b2", "kind": "heading", "content": "本周重点"},
                    {"id": "b4", "kind": "folder", "targetNodeId": "folder-research"}
                ],
                "editorDocument": [{"type": "paragraph"}],
                "markdown": ""
            }),
        )
        .expect("write legacy document");
        write_atomic(
            &project.join("notes/page-one.md"),
            "---\nid: page-one\ntitle: \"产品探索\"\nschemaVersion: 2\n---\n\n",
        )
        .expect("write empty generated note");

        let loaded = load_project_workspace(&project)
            .expect("load legacy project")
            .expect("workspace");
        let loaded: Value = serde_json::from_str(&loaded).expect("valid workspace");
        let markdown = loaded["noteMarkdown"]["page-one"]
            .as_str()
            .expect("markdown");
        assert!(markdown.contains("正文第一段"));
        assert!(markdown.contains("## 本周重点"));
        assert!(markdown.contains("```hyperspace"));
        assert!(!markdown.contains("---\nid: page-one"));

        let note = fs::read_to_string(project.join("notes/page-one.md")).expect("read note file");
        assert!(note.contains("正文第一段"));
        assert!(!root.join("documents/page-one.json").exists());
        assert!(root
            .join("migrations/pre-vditor/documents/page-one.json")
            .exists());

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn open_project_workspace_scans_real_files_and_ignores_generated_directories() {
        let project = test_directory("scan");
        fs::create_dir_all(project.join("src/components")).expect("create source tree");
        fs::create_dir_all(project.join("node_modules/pkg")).expect("create ignored tree");
        fs::create_dir_all(project.join(".git")).expect("create git directory");
        fs::create_dir_all(project.join(".idea")).expect("create hidden directory");
        fs::create_dir_all(project.join(".assets")).expect("create assets directory");
        fs::write(project.join("README.md"), "hello").expect("write readme");
        fs::write(project.join(".env"), "SECRET=hidden").expect("write hidden file");
        fs::write(project.join(".idea/workspace.xml"), "hidden")
            .expect("write file in hidden directory");
        fs::write(project.join(".assets/cover.png"), "image").expect("write assets file");
        fs::write(project.join("src/main.ts"), "export {};").expect("write source");
        fs::write(project.join("src/components/App.tsx"), "export default 1;")
            .expect("write component");
        fs::write(project.join("node_modules/pkg/index.js"), "ignored")
            .expect("write ignored dependency");

        let workspace = open_project_workspace(&project)
            .expect("scan project")
            .expect("workspace payload");
        let workspace: Value = serde_json::from_str(&workspace).expect("valid workspace JSON");
        let nodes = workspace["nodes"].as_array().expect("nodes array");
        let paths = nodes
            .iter()
            .filter_map(|node| node.get("localPath").and_then(Value::as_str))
            .collect::<HashSet<_>>();

        assert!(paths.contains("README.md"));
        assert!(paths.contains("src"));
        assert!(paths.contains("src/main.ts"));
        assert!(paths.contains("src/components/App.tsx"));
        assert!(paths.contains(".assets"));
        assert!(paths.contains(".assets/cover.png"));
        assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
        assert!(!paths.iter().any(|path| path.starts_with(".git")));
        assert!(!paths.contains(".env"));
        assert!(!paths.iter().any(|path| path.starts_with(".idea")));
        assert!(!paths.iter().any(|path| {
            path.split('/').any(|segment| {
                segment.starts_with('.') && segment != ASSETS_DIRECTORY_NAME
            })
        }));
        assert!(!is_ignored_fs_event(
            &project,
            &project.join(".assets/cover.png")
        ));
        assert!(is_ignored_fs_event(&project, &project.join(".env")));
        assert!(is_ignored_fs_event(
            &project,
            &project.join(".idea/workspace.xml")
        ));

        let src_id = filesystem_node_id("src");
        let main = nodes
            .iter()
            .find(|node| node["localPath"] == "src/main.ts")
            .expect("main node");
        assert_eq!(main["parentId"], src_id);
        assert_eq!(main["fileType"], "TS");

        let readme = nodes
            .iter()
            .find(|node| node["localPath"] == "README.md")
            .expect("readme node");
        let readme_id = readme["id"].as_str().expect("readme id");
        assert_eq!(workspace["noteMarkdown"][readme_id], "hello");

        let mut edited_workspace = workspace.clone();
        edited_workspace["noteMarkdown"][readme_id] = Value::String("# edited\n".into());

        save_project_workspace(&project, &edited_workspace.to_string())
            .expect("save scanned workspace");
        assert_eq!(
            fs::read_to_string(project.join("README.md")).expect("read edited markdown"),
            "# edited"
        );
        let reloaded = load_project_workspace(&project)
            .expect("load saved workspace")
            .expect("workspace exists");
        let reloaded: Value = serde_json::from_str(&reloaded).expect("valid reloaded JSON");
        assert_eq!(reloaded["noteMarkdown"][readme_id], "# edited");
        fs::remove_file(project.join("README.md")).expect("remove stale file");
        fs::write(project.join("src/new.ts"), "export const value = 1;")
            .expect("write newly discovered file");
        let reopened = open_project_workspace(&project)
            .expect("reopen project")
            .expect("reopened payload");
        let reopened: Value = serde_json::from_str(&reopened).expect("valid reopened workspace");
        let reopened_paths = reopened["nodes"]
            .as_array()
            .expect("reopened nodes")
            .iter()
            .filter_map(|node| node.get("localPath").and_then(Value::as_str))
            .collect::<HashSet<_>>();
        assert!(!reopened_paths.contains("README.md"));
        assert!(reopened_paths.contains("src/new.ts"));

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn saving_never_rewrites_markdown_files_it_did_not_change() {
        let project = test_directory("markdown-writes");
        fs::create_dir_all(&project).expect("create temp project");
        fs::write(project.join("kept.md"), "# 保留\n\n正文\n").expect("write untouched markdown");
        fs::write(project.join("edited.md"), "# 旧标题\n").expect("write edited markdown");
        // This one deliberately has no trailing newline; saving must not add one.
        fs::write(project.join("bare.md"), "# 无末尾换行").expect("write bare markdown");

        let opened = open_project_workspace(&project)
            .expect("open project")
            .expect("workspace");
        let mut workspace: Value = serde_json::from_str(&opened).expect("valid workspace");
        let id_of = |workspace: &Value, local_path: &str| {
            workspace["nodes"]
                .as_array()
                .expect("nodes")
                .iter()
                .find(|node| node["localPath"] == local_path)
                .expect("node")["id"]
                .as_str()
                .expect("id")
                .to_string()
        };
        let kept_id = id_of(&workspace, "kept.md");
        let edited_id = id_of(&workspace, "edited.md");

        // Only one buffer changes; the other must keep its original mtime.
        let kept_modified = fs::metadata(project.join("kept.md"))
            .and_then(|metadata| metadata.modified())
            .expect("kept mtime");
        std::thread::sleep(std::time::Duration::from_millis(20));
        workspace["noteMarkdown"][&edited_id] = Value::String("# 新标题".into());
        save_project_workspace(&project, &workspace.to_string()).expect("save one edit");

        assert_eq!(
            fs::metadata(project.join("kept.md"))
                .and_then(|metadata| metadata.modified())
                .expect("kept mtime after save"),
            kept_modified,
            "unchanged markdown must not be rewritten"
        );
        assert_eq!(
            fs::read_to_string(project.join("edited.md")).expect("read edited"),
            "# 新标题\n",
            "saved markdown keeps a trailing newline"
        );

        assert_eq!(
            fs::read_to_string(project.join("bare.md")).expect("read bare"),
            "# 无末尾换行",
            "saving preserves a file that had no trailing newline"
        );

        // Re-saving the same workspace is now a no-op for every file.
        let edited_modified = fs::metadata(project.join("edited.md"))
            .and_then(|metadata| metadata.modified())
            .expect("edited mtime");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let reopened = open_project_workspace(&project)
            .expect("reopen project")
            .expect("workspace");
        save_project_workspace(&project, &reopened).expect("save reopened workspace");
        assert_eq!(
            fs::metadata(project.join("edited.md"))
                .and_then(|metadata| metadata.modified())
                .expect("edited mtime after resave"),
            edited_modified,
            "reopening and saving must not rewrite anything"
        );

        // A buffer that was never loaded must not truncate the file behind it.
        workspace["noteMarkdown"][&kept_id] = Value::String(String::new());
        workspace["noteMarkdown"][&edited_id] = Value::String(String::new());
        save_project_workspace(&project, &workspace.to_string()).expect("save empty buffers");
        assert_eq!(
            fs::read_to_string(project.join("kept.md")).expect("read kept"),
            "# 保留\n\n正文\n"
        );
        assert_eq!(
            fs::read_to_string(project.join("edited.md")).expect("read edited"),
            "# 新标题\n"
        );

        let index = search_project(&project, "保留", 10).expect("search restored body");
        assert!(
            index.iter().any(|result| result.path == "kept.md"),
            "search index keeps the on-disk body when the buffer is empty"
        );

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn save_does_not_overwrite_external_markdown_with_stale_buffer() {
        let project = test_directory("stale-markdown");
        fs::create_dir_all(&project).expect("create temp project");
        fs::write(project.join("note.md"), "from hyperspace\n").expect("write markdown");

        let opened = open_project_workspace(&project)
            .expect("open project")
            .expect("workspace");
        save_project_workspace(&project, &opened).expect("establish written hash");

        let hashed = load_project_workspace(&project)
            .expect("load hashed workspace")
            .expect("workspace exists");
        fs::write(project.join("note.md"), "from typora\n").expect("external edit");
        save_project_workspace(&project, &hashed).expect("stale autosave");

        assert_eq!(
            fs::read_to_string(project.join("note.md")).expect("read after stale save"),
            "from typora\n",
            "stale HyperSpace buffer must not replace an external editor write"
        );

        let mut edited: Value = serde_json::from_str(&hashed).expect("valid hashed JSON");
        let note_id = edited["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .find(|node| node["localPath"] == "note.md")
            .expect("note node")["id"]
            .as_str()
            .expect("id")
            .to_string();
        edited["noteMarkdown"][&note_id] = Value::String("from hyperspace again".into());
        save_project_workspace(&project, &edited.to_string()).expect("user edit save");
        assert_eq!(
            fs::read_to_string(project.join("note.md")).expect("read user edit"),
            "from hyperspace again\n",
            "an actual HyperSpace edit still writes after the hash is established"
        );

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn external_rename_keeps_filesystem_node_metadata() {
        let project = test_directory("external-rename");
        fs::create_dir_all(&project).expect("create temp project");
        fs::write(project.join("before.md"), "body\n").expect("write markdown");

        let opened = open_project_workspace(&project)
            .expect("open project")
            .expect("workspace");
        let mut workspace: Value = serde_json::from_str(&opened).expect("valid workspace");
        let node = workspace["nodes"]
            .as_array_mut()
            .expect("nodes")
            .iter_mut()
            .find(|node| node["localPath"] == "before.md")
            .expect("markdown node");
        let original_id = node["id"].as_str().expect("id").to_string();
        node["markerColor"] = Value::String("purple".into());
        save_project_workspace(&project, &workspace.to_string()).expect("save metadata");

        fs::rename(project.join("before.md"), project.join("after.md")).expect("external rename");
        let reopened = open_project_workspace(&project)
            .expect("reopen project")
            .expect("workspace");
        let reopened: Value = serde_json::from_str(&reopened).expect("valid workspace");
        let renamed = reopened["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .find(|node| node["localPath"] == "after.md")
            .expect("renamed node");
        assert_eq!(renamed["id"], original_id);
        assert_eq!(renamed["markerColor"], "purple");

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn rename_and_delete_project_entries_change_the_disk() {
        let project = test_directory("entry-mutations");
        fs::create_dir_all(project.join("docs")).expect("create directory");
        fs::write(project.join("docs/old.md"), "body").expect("write file");

        let renamed =
            rename_project_entry(&project, "docs/old.md", "new.md").expect("rename entry");
        assert_eq!(renamed, "docs/new.md");
        assert!(!project.join("docs/old.md").exists());
        assert!(project.join("docs/new.md").exists());

        let assets = rename_project_entry(&project, "docs", ".assets").expect("rename assets folder");
        assert_eq!(assets, ".assets");
        assert!(project.join(".assets/new.md").is_file());
        assert!(
            rename_project_entry(&project, ".assets/new.md", ".hidden.md").is_err(),
            "hidden files should still be rejected"
        );

        delete_project_entries(&project, &[".assets".into()]).expect("delete directory");
        assert!(!project.join("docs").exists());
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn move_project_entry_relocates_files_and_rejects_nested_moves() {
        let project = test_directory("entry-move");
        fs::create_dir_all(project.join("docs/nested")).expect("create directories");
        fs::create_dir_all(project.join("assets")).expect("create destination");
        fs::write(project.join("docs/old.md"), "body").expect("write file");
        fs::write(project.join("assets/old.md"), "taken").expect("write colliding file");

        let moved = move_project_entry(&project, "docs/old.md", "assets").expect("move file");
        assert_eq!(moved, "assets/old (2).md");
        assert!(!project.join("docs/old.md").exists());
        assert_eq!(
            fs::read_to_string(project.join("assets/old (2).md")).expect("read moved file"),
            "body"
        );

        let same_dir = move_project_entry(&project, "assets/old.md", "assets").expect("same folder");
        assert_eq!(same_dir, "assets/old.md");

        let error = move_project_entry(&project, "docs", "docs/nested").expect_err("nested move");
        assert!(error.contains("自身内部"));

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn create_project_entry_writes_into_the_file_tree() {
        let project = test_directory("create-entry");
        fs::create_dir_all(project.join("docs")).expect("create directory");
        fs::write(project.join("docs/未命名页面.md"), "exists").expect("write existing page");

        let nested = create_project_entry(&project, "docs", "file").expect("create nested page");
        assert_eq!(nested.kind, "file");
        assert_eq!(nested.title, "未命名页面 (2).md");
        assert_eq!(nested.relative_path, "docs/未命名页面 (2).md");
        assert_eq!(nested.file_type.as_deref(), Some("MD"));
        assert_eq!(nested.id, filesystem_node_id("docs/未命名页面 (2).md"));
        assert_eq!(
            fs::read_to_string(project.join("docs/未命名页面 (2).md")).expect("read new page"),
            ""
        );

        let root = create_project_entry(&project, "", "file").expect("create root page");
        assert_eq!(root.relative_path, "未命名页面.md");
        assert!(project.join("未命名页面.md").is_file());
        assert!(!project.join("notes").exists());

        let folder = create_project_entry(&project, "docs", "folder").expect("create folder");
        assert_eq!(folder.kind, "folder");
        assert_eq!(folder.relative_path, "docs/新建文件夹");
        assert!(project.join("docs/新建文件夹").is_dir());

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn creating_after_rename_does_not_reuse_the_original_node_id() {
        let project = test_directory("create-after-rename");
        fs::create_dir_all(&project).expect("create temp project");

        let first = create_project_entry(&project, "", "folder").expect("create folder");
        assert_eq!(first.title, NEW_FOLDER_NAME);
        let opened = open_project_workspace(&project)
            .expect("open project")
            .expect("workspace");
        let mut workspace: Value = serde_json::from_str(&opened).expect("valid workspace");

        let renamed = rename_project_entry(&project, NEW_FOLDER_NAME, "资料").expect("rename");
        assert_eq!(renamed, "资料");
        for node in workspace["nodes"].as_array_mut().expect("nodes") {
            if node["id"] == first.id {
                node["title"] = Value::String("资料".into());
                node["localPath"] = Value::String("资料".into());
            }
        }
        save_project_workspace(&project, &workspace.to_string()).expect("save renamed sidecar");

        let second = create_project_entry(&project, "", "folder").expect("create original name again");
        assert_eq!(second.title, NEW_FOLDER_NAME);
        assert_ne!(
            second.id, first.id,
            "a reused default folder name must not inherit the renamed folder's id"
        );

        let scanned = scan_project_workspace(&project).expect("scan");
        let folders = scanned["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .filter(|node| node["kind"] == "folder")
            .collect::<Vec<_>>();
        assert_eq!(folders.len(), 2);
        let ids = folders
            .iter()
            .filter_map(|node| node["id"].as_str())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 2);
        let titles = folders
            .iter()
            .filter_map(|node| node["title"].as_str())
            .collect::<HashSet<_>>();
        assert_eq!(titles, HashSet::from(["资料", NEW_FOLDER_NAME]));

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn hidden_entries_follow_scan_options() {
        let default = ScanOptions::default();
        assert!(should_skip_entry(".env", false, &default));
        assert!(should_skip_entry(".idea", true, &default));
        assert!(should_skip_entry(".git", true, &default));
        assert!(!should_skip_entry(".assets", true, &default));
        assert!(!should_skip_entry("README.md", false, &default));

        let allowlisted = ScanOptions::new(true, [".env", ".idea"]);
        assert!(!should_skip_entry(".env", false, &allowlisted));
        assert!(!should_skip_entry(".idea", true, &allowlisted));
        assert!(should_skip_entry(".gitignore", false, &allowlisted));
        assert!(should_skip_entry(".hyperspace", true, &allowlisted));

        let show_hidden = ScanOptions::new(false, Vec::<String>::new());
        assert!(!should_skip_entry(".env", false, &show_hidden));
        assert!(!should_skip_entry(".idea", true, &show_hidden));
        assert!(should_skip_entry(".hyperspace", true, &show_hidden));
        assert!(should_skip_entry("node_modules", true, &show_hidden));
        assert!(should_skip_entry(".git", true, &show_hidden));

        let allow_git = ScanOptions::new(true, [".git"]);
        assert!(!should_skip_entry(".git", true, &allow_git));
        assert!(should_skip_entry(".env", false, &allow_git));
    }

    #[test]
    fn scan_can_show_allowlisted_hidden_files_and_folders() {
        let project = test_directory("visible-hidden");
        fs::create_dir_all(project.join(".github/workflows")).expect("create hidden tree");
        fs::create_dir_all(project.join(".idea")).expect("create ignored hidden directory");
        fs::write(project.join(".gitignore"), "target").expect("write gitignore");
        fs::write(project.join(".env"), "SECRET=1").expect("write env");
        fs::write(project.join(".github/workflows/ci.yml"), "name: ci").expect("write workflow");
        fs::write(project.join("README.md"), "hello").expect("write readme");

        let default_workspace = scan_project_workspace(&project).expect("default scan");
        let default_paths = default_workspace["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .filter_map(|node| node.get("localPath").and_then(Value::as_str))
            .collect::<HashSet<_>>();
        assert!(default_paths.contains("README.md"));
        assert!(!default_paths.contains(".gitignore"));
        assert!(!default_paths.contains(".env"));
        assert!(!default_paths.iter().any(|path| path.starts_with(".github")));

        let options = ScanOptions::new(true, [".gitignore", ".github"]);
        let workspace = scan_project_workspace_with_options(&project, &options).expect("scan");
        let paths = workspace["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .filter_map(|node| node.get("localPath").and_then(Value::as_str))
            .collect::<HashSet<_>>();
        assert!(paths.contains("README.md"));
        assert!(paths.contains(".gitignore"));
        assert!(paths.contains(".github"));
        assert!(paths.contains(".github/workflows/ci.yml"));
        assert!(!paths.contains(".env"));
        assert!(!paths.iter().any(|path| path.starts_with(".idea")));
        assert!(!is_ignored_fs_event_with_options(
            &project,
            &project.join(".gitignore"),
            &options
        ));
        assert!(is_ignored_fs_event_with_options(
            &project,
            &project.join(".env"),
            &options
        ));

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn import_editor_image_copies_into_assets_relative_to_the_note() {
        let project = test_directory("editor-image");
        fs::create_dir_all(project.join("docs")).expect("create note directory");
        let source = project.join("Cover Photo.png");
        fs::write(&source, b"png-bytes").expect("write source image");

        let imported = import_editor_image(&project, Some(&source), None, None, "docs/note.md")
            .expect("import image");
        assert_eq!(imported.markdown_path, "../.assets/Cover-Photo.png");
        assert_eq!(
            fs::read(project.join(".assets/Cover-Photo.png")).expect("read copy"),
            b"png-bytes"
        );

        let again = import_editor_image(&project, Some(&source), None, None, "note.md")
            .expect("import duplicate");
        assert_eq!(again.markdown_path, ".assets/Cover-Photo-2.png");

        let pasted = import_editor_image(&project, None, Some(b"paste"), Some("My Photo.PNG"), "")
            .expect("import pasted bytes");
        assert_eq!(pasted.markdown_path, ".assets/My-Photo.png");
        assert_eq!(
            fs::read(project.join(".assets/My-Photo.png")).expect("read paste"),
            b"paste"
        );

        assert!(import_editor_image(&project, None, Some(b"nope"), Some("notes.md"), "note.md").is_err());
        assert!(import_editor_image(&project, None, Some(b"x"), Some("shot.png"), "../note.md").is_err());

        fs::remove_dir_all(project).expect("remove temp project");
    }
}
