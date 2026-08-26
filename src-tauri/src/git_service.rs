use crate::{
    project_settings::ResolvedGitToolchain,
    workspace_store::write_atomic,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub authored_at: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryInfo {
    pub git_available: bool,
    pub is_repository: bool,
    pub lfs_available: bool,
    pub branch: String,
    pub changes: Vec<GitChange>,
    pub history: Vec<GitCommit>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub id: String,
    pub title: String,
    pub relative_path: String,
    pub size: u64,
    pub content_hash: String,
    pub lfs_tracked: bool,
}

fn run(
    toolchain: &ResolvedGitToolchain,
    program: &Path,
    args: &[&str],
    current_dir: &Path,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(current_dir);
    if let Some(directory) = toolchain.managed_lfs_directory.as_ref() {
        let mut paths = vec![directory.clone()];
        if let Some(current) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&current));
        }
        let path = std::env::join_paths(paths).map_err(|error| error.to_string())?;
        command.env("PATH", path);
    }
    if let Some(ssh_command) = toolchain.git_ssh_command.as_ref() {
        command.env("GIT_SSH_COMMAND", ssh_command);
    }
    command
        .output()
        .map_err(|error| format!("Failed to run {}: {error}", program.display()))
}

fn successful_output(
    toolchain: &ResolvedGitToolchain,
    program: &Path,
    args: &[&str],
    current_dir: &Path,
) -> Result<String, String> {
    let output = run(toolchain, program, args, current_dir)?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if message.is_empty() {
        format!("{} {} failed", program.display(), args.join(" "))
    } else {
        message
    })
}

pub fn git_available(toolchain: &ResolvedGitToolchain, project_path: &Path) -> bool {
    run(toolchain, &toolchain.git_program, &["--version"], project_path)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub fn lfs_available(toolchain: &ResolvedGitToolchain, project_path: &Path) -> bool {
    toolchain
        .lfs_program
        .as_ref()
        .and_then(|program| run(toolchain, program, &["version"], project_path).ok())
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn append_missing_lines(path: &Path, lines: &[&str]) -> Result<(), String> {
    let current = fs::read_to_string(path).unwrap_or_default();
    let mut next = current.trim_end().to_string();
    for line in lines {
        if !current.lines().any(|existing| existing.trim() == *line) {
            if !next.is_empty() {
                next.push('\n');
            }
            next.push_str(line);
        }
    }
    if !next.is_empty() {
        next.push('\n');
    }
    write_atomic(path, &next)
}

pub fn ensure_project_support_files(project_path: &Path) -> Result<(), String> {
    append_missing_lines(
        &project_path.join(".gitignore"),
        &[
            ".hyperspace/state.db",
            ".hyperspace/index/",
            ".hyperspace/cache/",
            ".hyperspace/tmp/",
            ".hyperspace/search-index.json",
            ".hyperspace/settings.local.json",
            ".hyperspace/workspace.json",
            ".hyperspace/workspace.json.*",
        ],
    )?;
    append_missing_lines(
        &project_path.join(".gitattributes"),
        &["*.pdf filter=lfs diff=lfs merge=lfs -text"],
    )?;
    Ok(())
}

pub fn init_repository(
    toolchain: &ResolvedGitToolchain,
    project_path: &Path,
) -> Result<(), String> {
    successful_output(toolchain, &toolchain.git_program, &["init"], project_path)?;
    ensure_project_support_files(project_path)?;
    if lfs_available(toolchain, project_path) {
        if let Some(lfs) = toolchain.lfs_program.as_ref() {
            successful_output(toolchain, lfs, &["install", "--local"], project_path)?;
        }
    }
    Ok(())
}

fn parse_status(output: &str) -> Vec<GitChange> {
    output
        .lines()
        .filter_map(|line| {
            if line.len() < 3 {
                return None;
            }
            Some(GitChange {
                status: if &line[..2] == "??" {
                    "untracked".into()
                } else {
                    line[..2].trim().to_string()
                },
                path: line[3..].trim_matches('"').to_string(),
            })
        })
        .collect()
}

fn history(toolchain: &ResolvedGitToolchain, project_path: &Path) -> Vec<GitCommit> {
    let format = "%H%x1f%h%x1f%an%x1f%aI%x1f%s";
    let Ok(output) = successful_output(
        toolchain,
        &toolchain.git_program,
        &["log", "-n", "20", &format!("--pretty=format:{format}")],
        project_path,
    ) else {
        return Vec::new();
    };
    output
        .lines()
        .filter_map(|line| {
            let parts = line.split('\x1f').collect::<Vec<_>>();
            if parts.len() != 5 {
                return None;
            }
            Some(GitCommit {
                id: parts[0].to_string(),
                short_id: parts[1].to_string(),
                author: parts[2].to_string(),
                authored_at: parts[3].to_string(),
                subject: parts[4].to_string(),
            })
        })
        .collect()
}

pub fn repository_info(
    toolchain: &ResolvedGitToolchain,
    project_path: &Path,
) -> GitRepositoryInfo {
    let has_git = git_available(toolchain, project_path);
    let is_repository = project_path.join(".git").exists();
    if !has_git || !is_repository {
        return GitRepositoryInfo {
            git_available: has_git,
            is_repository,
            lfs_available: has_git && lfs_available(toolchain, project_path),
            branch: String::new(),
            changes: Vec::new(),
            history: Vec::new(),
            error: None,
        };
    }

    let branch = successful_output(
        toolchain,
        &toolchain.git_program,
        &["branch", "--show-current"],
        project_path,
    )
    .unwrap_or_else(|_| "HEAD".into());
    match successful_output(
        toolchain,
        &toolchain.git_program,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        project_path,
    ) {
        Ok(status) => GitRepositoryInfo {
            git_available: true,
            is_repository: true,
            lfs_available: lfs_available(toolchain, project_path),
            branch,
            changes: parse_status(&status),
            history: history(toolchain, project_path),
            error: None,
        },
        Err(error) => GitRepositoryInfo {
            git_available: true,
            is_repository: true,
            lfs_available: lfs_available(toolchain, project_path),
            branch,
            changes: Vec::new(),
            history: history(toolchain, project_path),
            error: Some(error),
        },
    }
}

pub fn commit_all(
    toolchain: &ResolvedGitToolchain,
    project_path: &Path,
    message: &str,
) -> Result<GitRepositoryInfo, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("请输入提交说明".into());
    }
    if !project_path.join(".git").exists() {
        return Err("当前项目尚未启用 Git".into());
    }
    successful_output(toolchain, &toolchain.git_program, &["add", "-A"], project_path)?;
    successful_output(
        toolchain,
        &toolchain.git_program,
        &["commit", "-m", message],
        project_path,
    )
    .map_err(|error| {
        if error.contains("Author identity unknown") {
            "Git 尚未配置用户名和邮箱，请先配置 user.name 与 user.email".into()
        } else {
            error
        }
    })?;
    Ok(repository_info(toolchain, project_path))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn unique_destination(directory: &Path, file_name: &str) -> PathBuf {
    let original = Path::new(file_name);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");
    let first = directory.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for suffix in 2..10_000 {
        let candidate = directory.join(format!("{stem} ({suffix}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-imported.{extension}"))
}

pub fn import_pdf(
    toolchain: &ResolvedGitToolchain,
    project_path: &Path,
    source_path: &Path,
) -> Result<ImportedFile, String> {
    if source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .as_deref()
        != Some("pdf")
    {
        return Err("当前闭环只支持导入 PDF 文件".into());
    }
    if !source_path.is_file() {
        return Err("选择的 PDF 文件不存在".into());
    }

    let is_repository = project_path.join(".git").exists();
    if is_repository && !lfs_available(toolchain, project_path) {
        return Err("当前设备尚未安装 Git LFS。请安装并执行 git lfs install 后再导入 PDF。".into());
    }
    if is_repository {
        let lfs = toolchain
            .lfs_program
            .as_ref()
            .ok_or_else(|| "当前 Git LFS 工具不可用".to_string())?;
        successful_output(toolchain, lfs, &["install", "--local"], project_path)?;
        successful_output(toolchain, lfs, &["track", "*.pdf"], project_path)?;
    }

    let attachments = project_path.join("attachments");
    fs::create_dir_all(&attachments).map_err(|error| error.to_string())?;
    let title = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "PDF 文件名不是有效的 UTF-8".to_string())?;
    let destination = unique_destination(&attachments, title);
    let temporary = destination.with_extension("pdf.importing");
    fs::copy(source_path, &temporary).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;

    let metadata = fs::metadata(&destination).map_err(|error| error.to_string())?;
    let content_hash = sha256_file(&destination)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let relative_path = destination
        .strip_prefix(project_path)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(ImportedFile {
        id: format!("file-{timestamp}-{}", &content_hash[..8]),
        title: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(title)
            .to_string(),
        relative_path,
        size: metadata.len(),
        content_hash,
        lfs_tracked: is_repository,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn status_parser_reads_untracked_and_modified_entries() {
        let changes = parse_status(" M notes/page.md\n?? attachments/report.pdf\n");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].status, "M");
        assert_eq!(changes[0].path, "notes/page.md");
        assert_eq!(changes[1].status, "untracked");
    }

    #[test]
    fn imported_pdf_is_materialized_in_worktree_and_staged_as_lfs_pointer() {
        let toolchain = ResolvedGitToolchain::system();
        if !git_available(&toolchain, Path::new("."))
            || !lfs_available(&toolchain, Path::new("."))
        {
            return;
        }
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hyperspace-lfs-{unique}"));
        let project = root.join("project");
        fs::create_dir_all(&project).expect("create project");
        let source = root.join("sample.pdf");
        let pdf = b"%PDF-1.4\nHyperSpace LFS integration test\n%%EOF\n";
        fs::write(&source, pdf).expect("write sample PDF");

        init_repository(&toolchain, &project).expect("initialize repository");
        let imported = import_pdf(&toolchain, &project, &source).expect("import PDF");
        assert!(imported.lfs_tracked);
        assert_eq!(
            fs::read(project.join(&imported.relative_path)).expect("read working tree PDF"),
            pdf
        );

        successful_output(&toolchain, &toolchain.git_program, &["add", "-A"], &project)
            .expect("stage project");
        let pointer = successful_output(
            &toolchain,
            &toolchain.git_program,
            &["show", &format!(":{}", imported.relative_path)],
            &project,
        )
        .expect("read staged LFS pointer");
        assert!(pointer.contains("version https://git-lfs.github.com/spec/v1"));
        assert!(pointer.contains(&format!("oid sha256:{}", imported.content_hash)));

        fs::remove_dir_all(root).expect("remove temp project");
    }
}
