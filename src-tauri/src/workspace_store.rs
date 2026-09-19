use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const SCHEMA_VERSION: u64 = 2;
const PROJECT_DIR_NAME: &str = ".hyperspace";
const LEGACY_WORKSPACE_FILE: &str = "workspace.json";
const MANIFEST_FILE: &str = "manifest.json";
const SEARCH_INDEX_FILE: &str = "search-index.json";
const MAX_SCANNED_NODES: usize = 20_000;
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

fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn filesystem_node_id(relative_path: &str) -> String {
    let digest = Sha256::digest(relative_path.as_bytes());
    let short_hash = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("fs-{short_hash}")
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
    existing_path_ids: &HashMap<String, String>,
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
            return Err(format!("文件夹内容超过 {MAX_SCANNED_NODES} 项，无法完整展示"));
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
        if let Some(existing_id) = existing_path_ids.get(&relative_path) {
            if file_type.is_dir() {
                scan_directory(
                    project_path,
                    &path,
                    Some(existing_id),
                    existing_path_ids,
                    nodes,
                )?;
            }
            continue;
        }

        let id = filesystem_node_id(&relative_path);
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let mut node = json!({
            "id": id,
            "parentId": parent_id,
            "kind": if file_type.is_dir() { "folder" } else { "file" },
            "title": name,
            "updatedAt": display_modified(&metadata),
            "localPath": relative_path,
        });
        if file_type.is_file() {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("FILE")
                .to_uppercase();
            node["fileType"] = Value::String(extension);
            node["size"] = Value::String(display_size(metadata.len()));
        }
        nodes.push(node);

        if file_type.is_dir() {
            scan_directory(
                project_path,
                &path,
                Some(&id),
                existing_path_ids,
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
        .unwrap_or_else(|| json!({
            "nodes": [],
            "blocks": {},
            "editorDocuments": {},
            "noteMarkdown": {}
        }));

    let mut existing_nodes = workspace
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // Filesystem nodes are a view of the current directory and must be rebuilt
    // on every open so deleted and newly created files are reflected accurately.
    existing_nodes.retain(|node| {
        !node
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("fs-"))
    });
    let mut existing_path_ids = existing_nodes
        .iter()
        .filter_map(|node| {
            let path = node.get("localPath").and_then(Value::as_str)?;
            let id = node.get("id").and_then(Value::as_str)?;
            (!path.is_empty()).then(|| (path.to_string(), id.to_string()))
        })
        .collect::<HashMap<_, _>>();
    for node in &existing_nodes {
        if node.get("kind").and_then(Value::as_str) == Some("page") {
            if let Some(id) = node.get("id").and_then(Value::as_str) {
                existing_path_ids.insert(format!("notes/{id}.md"), id.to_string());
            }
        }
    }

    workspace["nodes"] = Value::Array(existing_nodes);

    let mut scanned_nodes = Vec::new();
    scan_directory(
        project_path,
        project_path,
        None,
        &existing_path_ids,
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

    if workspace.get("selectedNodeId").and_then(Value::as_str).is_none() {
        if let Some(id) = first_node_id {
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

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_atomic(path, &format!("{payload}\n"))
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
                "<!-- hs:block id={} type={} target={} -->",
                value_string(block.get("id")),
                kind,
                value_string(block.get("targetNodeId"))
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
        return markdown.trim().to_string();
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
    fs::create_dir_all(&notes_dir).map_err(|error| error.to_string())?;

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
        write_json(&nodes_dir.join(format!("{id}.json")), &node_sidecar)?;

        let tag_names = node
            .get("tagIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|tag_id| tags_by_id.get(tag_id).cloned())
            .collect::<Vec<_>>();

        let content = if kind == "page" {
            valid_page_ids.insert(id.clone());
            let body = note_body(&workspace, &id);
            write_atomic(
                &notes_dir.join(format!("{id}.md")),
                &markdown_file(&id, &title, &body),
            )?;
            let document = json!({
              "blocks": object.get("blocks").and_then(|value| value.get(&id)).cloned().unwrap_or_else(|| json!([])),
              "editorDocument": object.get("editorDocuments").and_then(|value| value.get(&id)).cloned().unwrap_or(Value::Null),
              "markdown": body,
            });
            write_json(&documents_dir.join(format!("{id}.json")), &document)?;
            document
                .get("markdown")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        } else {
            String::new()
        };

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
    remove_stale_generated_notes(&notes_dir, &valid_page_ids)?;

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
    let mut blocks = Map::new();
    let mut editor_documents = Map::new();
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
            blocks.insert(
                id.to_string(),
                document.get("blocks").cloned().unwrap_or_else(|| json!([])),
            );
            if let Some(editor_document) = document
                .get("editorDocument")
                .filter(|value| !value.is_null())
            {
                editor_documents.insert(id.to_string(), editor_document.clone());
            }
            note_markdown.insert(
                id.to_string(),
                document
                    .get("markdown")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
        }
    }

    workspace.insert("nodes".into(), Value::Array(nodes));
    workspace.insert("blocks".into(), Value::Object(blocks));
    workspace.insert("editorDocuments".into(), Value::Object(editor_documents));
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

        save_project_workspace(&project, &workspace.to_string()).expect("save scanned workspace");
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
}
