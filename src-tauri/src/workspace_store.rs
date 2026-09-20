use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

const SCHEMA_VERSION: u64 = 2;
const PROJECT_DIR_NAME: &str = ".hyperspace";
const LEGACY_WORKSPACE_FILE: &str = "workspace.json";
const MANIFEST_FILE: &str = "manifest.json";
const SEARCH_INDEX_FILE: &str = "search-index.json";
const VDITOR_MIGRATION_DIR: &str = "migrations/pre-vditor";
const MAX_SCANNED_NODES: usize = 20_000;
const NEW_PAGE_FILE_NAME: &str = "未命名页面.md";
const NEW_FOLDER_NAME: &str = "新建文件夹";
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
        if name.starts_with('.') {
            continue;
        }
        if file_type.is_dir() && IGNORED_DIRECTORY_NAMES.contains(&name.as_str()) {
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
        let id = existing
            .and_then(|node| node.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| filesystem_node_id(&relative_path));
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
            )?;
        }
    }
    Ok(())
}

pub fn open_project_workspace(project_path: &Path) -> Result<Option<String>, String> {
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
    scan_directory(
        project_path,
        project_path,
        None,
        &existing_by_path,
        &existing_by_identity,
        &mut scanned_nodes,
    )?;
    let (first_node_id, is_empty) = {
        let nodes = workspace
            .as_object_mut()
            .ok_or_else(|| "Workspace must be a JSON object".to_string())?
            .entry("nodes")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| "Workspace nodes must be an array".to_string())?;
        nodes.extend(scanned_nodes);
        (
            nodes.first().and_then(|node| node.get("id")).cloned(),
            nodes.is_empty(),
        )
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
    let name_path = Path::new(normalized);
    if normalized.is_empty()
        || normalized.starts_with('.')
        || name_path.components().count() != 1
        || !matches!(
            name_path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err("文件名不能为空、不能以点开头，也不能包含路径分隔符".into());
    }
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
    let name_path = Path::new(&title);
    if title.is_empty()
        || title.starts_with('.')
        || name_path.components().count() != 1
        || !matches!(
            name_path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err("文件名不能为空、不能以点开头，也不能包含路径分隔符".into());
    }
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
    Ok(CreatedWorkspaceEntry {
        id: filesystem_node_id(&relative_path),
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
        "---\nid: {node_id}\ntitle: {yaml_title}\nschemaVersion: {SCHEMA_VERSION}\n---\n\n{}\n",
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

pub fn save_project_workspace(project_path: &Path, payload: &str) -> Result<(), String> {
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
    fs::create_dir_all(&documents_dir).map_err(|error| error.to_string())?;

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

        let mut node_sidecar = node.clone();
        let path = if kind == "page" {
            format!("notes/{id}.md")
        } else {
            node.get("localPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        if let Some(sidecar) = node_sidecar.as_object_mut() {
            sidecar.insert("storagePath".into(), Value::String(path.clone()));
        }
        let tag_names = node
            .get("tagIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|tag_id| tags_by_id.get(tag_id).cloned())
            .collect::<Vec<_>>();

        let is_markdown_file = is_markdown_file_node(node);
        let content = if kind == "page" {
            valid_page_ids.insert(id.clone());
            fs::create_dir_all(&notes_dir).map_err(|error| error.to_string())?;
            let notes_path = notes_dir.join(format!("{id}.md"));
            let mut body = note_body(&workspace, &id);
            if body.trim().is_empty() {
                let existing = fs::read_to_string(&notes_path)
                    .ok()
                    .map(|text| strip_generated_front_matter(&text))
                    .unwrap_or_default();
                if !existing.trim().is_empty() {
                    body = existing;
                }
            }
            write_atomic_if_changed(&notes_path, &markdown_file(&id, &title, &body))?;
            let document = json!({
              "formatVersion": 1,
              "markdown": body,
            });
            write_json(&documents_dir.join(format!("{id}.json")), &document)?;
            document
                .get("markdown")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
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
                write_atomic_if_changed(&source_path, &payload)?;
                body
            }
        } else {
            String::new()
        };

        if kind != "page" && !path.is_empty() {
            if let Ok(source_path) = safe_project_entry(project_path, &path) {
                let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
                if let (Some(sidecar), Some(identity)) =
                    (node_sidecar.as_object_mut(), file_identity(&metadata))
                {
                    sidecar.insert("fileIdentity".into(), Value::String(identity));
                }
            }
        }
        write_json(&nodes_dir.join(format!("{id}.json")), &node_sidecar)?;

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

    let mut manifest = Map::new();
    manifest.insert("schemaVersion".into(), Value::Number(SCHEMA_VERSION.into()));
    manifest.insert("nodeOrder".into(), Value::Array(node_order));
    for key in ["selectedNodeId", "tags", "lastSavedAt"] {
        if let Some(value) = object.get(key) {
            manifest.insert(key.into(), value.clone());
        }
    }
    write_json(&root.join(MANIFEST_FILE), &Value::Object(manifest))?;
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

    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Invalid workspace manifest: {error}"))?;
    let mut workspace = Map::new();
    for key in ["selectedNodeId", "tags", "lastSavedAt"] {
        if let Some(value) = manifest.get(key) {
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
        let node: Value = serde_json::from_str(
            &fs::read_to_string(&node_path)
                .map_err(|error| format!("Failed to read {}: {error}", node_path.display()))?,
        )
        .map_err(|error| format!("Invalid node sidecar {}: {error}", node_path.display()))?;
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
            let document_path = root.join("documents").join(format!("{id}.json"));
            let document: Value =
                serde_json::from_str(&fs::read_to_string(&document_path).map_err(|error| {
                    format!("Failed to read {}: {error}", document_path.display())
                })?)
                .map_err(|error| {
                    format!("Invalid note document {}: {error}", document_path.display())
                })?;
            let notes_relative = format!("notes/{id}.md");
            let file_body = read_markdown_file(project_path, &notes_relative)
                .map(|text| strip_generated_front_matter(&text))
                .unwrap_or_default();
            let migrated = document_markdown(&document);
            let markdown = if !file_body.trim().is_empty() {
                file_body.clone()
            } else {
                migrated
            };
            if document.get("blocks").is_some() || document.get("editorDocument").is_some() {
                backup_legacy_file(
                    &root,
                    &document_path,
                    &PathBuf::from("documents").join(format!("{id}.json")),
                )?;
                write_json(
                    &document_path,
                    &json!({"formatVersion": 1, "markdown": markdown}),
                )?;
            }
            if file_body.trim().is_empty() && !markdown.trim().is_empty() {
                write_atomic(
                    &project_path.join("notes").join(format!("{id}.md")),
                    &markdown_file(id, &title, &markdown),
                )?;
            }
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
        assert_eq!(loaded["noteMarkdown"]["page-one"], "离线优先的正文");
        assert!(loaded.get("blocks").is_none());
        assert!(loaded.get("editorDocuments").is_none());
        let document: Value = serde_json::from_str(
            &fs::read_to_string(project.join(".hyperspace/documents/page-one.json"))
                .expect("read markdown document"),
        )
        .expect("valid markdown document");
        assert_eq!(document["formatVersion"], 1);
        assert!(document.get("blocks").is_none());
        assert!(document.get("editorDocument").is_none());

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
        assert!(root
            .join("migrations/pre-vditor/documents/page-one.json")
            .exists());

        let active: Value = serde_json::from_str(
            &fs::read_to_string(root.join("documents/page-one.json")).expect("active document"),
        )
        .expect("valid active document");
        assert_eq!(
            active,
            json!({"formatVersion": 1, "markdown": "legacy body"})
        );

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
        let active: Value = serde_json::from_str(
            &fs::read_to_string(root.join("documents/page-one.json")).expect("active document"),
        )
        .expect("valid active document");
        assert_eq!(active["formatVersion"], 1);
        assert!(active.get("blocks").is_none());
        assert!(active["markdown"].as_str().unwrap().contains("正文第一段"));

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn open_project_workspace_scans_real_files_and_ignores_generated_directories() {
        let project = test_directory("scan");
        fs::create_dir_all(project.join("src/components")).expect("create source tree");
        fs::create_dir_all(project.join("node_modules/pkg")).expect("create ignored tree");
        fs::create_dir_all(project.join(".git")).expect("create git directory");
        fs::create_dir_all(project.join(".idea")).expect("create hidden directory");
        fs::write(project.join("README.md"), "hello").expect("write readme");
        fs::write(project.join(".env"), "SECRET=hidden").expect("write hidden file");
        fs::write(project.join(".idea/workspace.xml"), "hidden")
            .expect("write file in hidden directory");
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
        assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
        assert!(!paths.iter().any(|path| path.starts_with(".git")));
        assert!(!paths.iter().any(|path| path.starts_with('.')));

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

        delete_project_entries(&project, &["docs".into()]).expect("delete directory");
        assert!(!project.join("docs").exists());
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
}
