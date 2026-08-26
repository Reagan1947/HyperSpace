use crate::workspace_store::write_atomic;
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.local.json";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    Managed,
    #[default]
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    #[serde(default)]
    pub git_source: ToolSource,
    #[serde(default)]
    pub lfs_source: ToolSource,
    #[serde(default)]
    pub ssh_source: ToolSource,
    #[serde(default)]
    pub managed_ssh_key: Option<String>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            git_source: ToolSource::System,
            lfs_source: ToolSource::System,
            ssh_source: ToolSource::System,
            managed_ssh_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub available: bool,
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainInfo {
    pub system_git: ToolInfo,
    pub managed_git: ToolInfo,
    pub system_lfs: ToolInfo,
    pub managed_lfs: ToolInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub public_key: String,
    pub has_private_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsSnapshot {
    pub settings: ProjectSettings,
    pub toolchain: ToolchainInfo,
    pub managed_ssh_directory: String,
    pub system_ssh_directory: String,
    pub ssh_keys: Vec<SshKeyInfo>,
    pub ssh_config: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectSettingsRequest {
    pub settings: ProjectSettings,
    #[serde(default)]
    pub ssh_config: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedGitToolchain {
    pub git_program: PathBuf,
    pub lfs_program: Option<PathBuf>,
    pub managed_lfs_directory: Option<PathBuf>,
    pub git_ssh_command: Option<String>,
}

impl ResolvedGitToolchain {
    #[cfg(test)]
    pub fn system() -> Self {
        Self {
            git_program: find_in_path("git").unwrap_or_else(|| PathBuf::from("git")),
            lfs_program: find_in_path("git-lfs"),
            managed_lfs_directory: None,
            git_ssh_command: None,
        }
    }
}

fn settings_path(project_path: &Path) -> PathBuf {
    project_path.join(".hyperspace").join(SETTINGS_FILE)
}

fn managed_ssh_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("ssh"))
        .map_err(|error| error.to_string())
}

fn system_ssh_directory() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".ssh")
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let executable = executable_name(name);
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|path| path.join(&executable))
            .find(|path| path.is_file())
    })
}

fn managed_tool_candidates(app: &AppHandle, name: &str) -> Vec<PathBuf> {
    let executable = executable_name(name);
    let mut candidates = Vec::new();
    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("toolchain").join("bin").join(&executable));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("toolchain").join("bin").join(&executable));
    }
    candidates
}

fn managed_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    managed_tool_candidates(app, name)
        .into_iter()
        .find(|path| path.is_file())
}

fn tool_info(path: Option<PathBuf>, arguments: &[&str]) -> ToolInfo {
    let Some(path) = path else {
        return ToolInfo {
            available: false,
            path: String::new(),
            version: String::new(),
        };
    };
    match Command::new(&path).args(arguments).output() {
        Ok(output) if output.status.success() => ToolInfo {
            available: true,
            path: path.to_string_lossy().into_owned(),
            version: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        },
        _ => ToolInfo {
            available: false,
            path: path.to_string_lossy().into_owned(),
            version: String::new(),
        },
    }
}

pub fn load_settings(project_path: &Path) -> Result<ProjectSettings, String> {
    let path = settings_path(project_path);
    if !path.exists() {
        return Ok(ProjectSettings::default());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid project settings: {error}"))
}

fn set_private_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn safe_key_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("密钥名称只能包含字母、数字、短横线和下划线".into());
    }
    Ok(name.to_string())
}

fn list_managed_keys(directory: &Path) -> Result<Vec<SshKeyInfo>, String> {
    let keys_directory = directory.join("keys");
    if !keys_directory.exists() {
        return Ok(Vec::new());
    }
    let mut keys = Vec::new();
    for entry in fs::read_dir(&keys_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) == Some("pub") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let public_path = keys_directory.join(format!("{name}.pub"));
        keys.push(SshKeyInfo {
            name: name.to_string(),
            public_key: fs::read_to_string(public_path)
                .unwrap_or_default()
                .trim()
                .to_string(),
            has_private_key: true,
        });
    }
    keys.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(keys)
}

pub fn snapshot(app: &AppHandle, project_path: &Path) -> Result<ProjectSettingsSnapshot, String> {
    let managed_ssh = managed_ssh_directory(app)?;
    let config_path = managed_ssh.join("config");
    Ok(ProjectSettingsSnapshot {
        settings: load_settings(project_path)?,
        toolchain: ToolchainInfo {
            system_git: tool_info(find_in_path("git"), &["--version"]),
            managed_git: tool_info(managed_tool(app, "git"), &["--version"]),
            system_lfs: tool_info(find_in_path("git-lfs"), &["version"]),
            managed_lfs: tool_info(managed_tool(app, "git-lfs"), &["version"]),
        },
        managed_ssh_directory: managed_ssh.to_string_lossy().into_owned(),
        system_ssh_directory: system_ssh_directory().to_string_lossy().into_owned(),
        ssh_keys: list_managed_keys(&managed_ssh)?,
        ssh_config: fs::read_to_string(config_path).unwrap_or_default(),
    })
}

pub fn save(
    app: &AppHandle,
    project_path: &Path,
    request: SaveProjectSettingsRequest,
) -> Result<ProjectSettingsSnapshot, String> {
    let status = snapshot(app, project_path)?;
    if request.settings.git_source == ToolSource::Managed && !status.toolchain.managed_git.available
    {
        return Err("当前安装包未包含内置 Git，无法启用".into());
    }
    if request.settings.lfs_source == ToolSource::Managed && !status.toolchain.managed_lfs.available
    {
        return Err("当前安装包未包含内置 Git LFS，无法启用".into());
    }

    let managed_ssh = managed_ssh_directory(app)?;
    if request.settings.ssh_source == ToolSource::Managed {
        if let Some(key) = request.settings.managed_ssh_key.as_deref() {
            let key = safe_key_name(key)?;
            if !managed_ssh.join("keys").join(key).is_file() {
                return Err("选择的托管 SSH 密钥不存在".into());
            }
        }
        fs::create_dir_all(&managed_ssh).map_err(|error| error.to_string())?;
        let config_path = managed_ssh.join("config");
        write_atomic(&config_path, request.ssh_config.trim_end())?;
        set_private_permissions(&config_path)?;
    }

    let payload = serde_json::to_string_pretty(&request.settings)
        .map_err(|error| error.to_string())?;
    write_atomic(&settings_path(project_path), &format!("{payload}\n"))?;
    snapshot(app, project_path)
}

pub fn import_key(
    app: &AppHandle,
    project_path: &Path,
    source_path: &Path,
    name: &str,
) -> Result<ProjectSettingsSnapshot, String> {
    if !source_path.is_file() {
        return Err("选择的 SSH 私钥不存在".into());
    }
    let name = safe_key_name(name)?;
    let managed_ssh = managed_ssh_directory(app)?;
    let keys_directory = managed_ssh.join("keys");
    fs::create_dir_all(&keys_directory).map_err(|error| error.to_string())?;
    let destination = keys_directory.join(&name);
    if destination.exists() {
        return Err("同名托管密钥已经存在".into());
    }
    fs::copy(source_path, &destination).map_err(|error| error.to_string())?;
    set_private_permissions(&destination)?;

    let source_public = source_path.with_extension(format!(
        "{}pub",
        source_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|extension| format!("{extension}."))
            .unwrap_or_default()
    ));
    if source_public.is_file() {
        fs::copy(source_public, keys_directory.join(format!("{name}.pub")))
            .map_err(|error| error.to_string())?;
    }
    snapshot(app, project_path)
}

pub fn generate_key(
    app: &AppHandle,
    project_path: &Path,
    name: &str,
    comment: &str,
) -> Result<ProjectSettingsSnapshot, String> {
    let name = safe_key_name(name)?;
    let ssh_keygen = find_in_path("ssh-keygen")
        .ok_or_else(|| "系统未找到 ssh-keygen，无法生成密钥".to_string())?;
    let managed_ssh = managed_ssh_directory(app)?;
    let keys_directory = managed_ssh.join("keys");
    fs::create_dir_all(&keys_directory).map_err(|error| error.to_string())?;
    let destination = keys_directory.join(&name);
    if destination.exists() {
        return Err("同名托管密钥已经存在".into());
    }
    let output = Command::new(ssh_keygen)
        .args(["-q", "-t", "ed25519", "-N", "", "-C"])
        .arg(comment.trim())
        .arg("-f")
        .arg(&destination)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    set_private_permissions(&destination)?;
    snapshot(app, project_path)
}

pub fn delete_key(
    app: &AppHandle,
    project_path: &Path,
    name: &str,
) -> Result<ProjectSettingsSnapshot, String> {
    let name = safe_key_name(name)?;
    let keys_directory = managed_ssh_directory(app)?.join("keys");
    let private_key = keys_directory.join(&name);
    let public_key = keys_directory.join(format!("{name}.pub"));
    if private_key.exists() {
        fs::remove_file(private_key).map_err(|error| error.to_string())?;
    }
    if public_key.exists() {
        fs::remove_file(public_key).map_err(|error| error.to_string())?;
    }
    snapshot(app, project_path)
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

pub fn resolve_git_toolchain(
    app: &AppHandle,
    project_path: &Path,
) -> Result<ResolvedGitToolchain, String> {
    let settings = load_settings(project_path)?;
    let git_program = match settings.git_source {
        ToolSource::System => find_in_path("git").unwrap_or_else(|| PathBuf::from("git")),
        ToolSource::Managed => managed_tool(app, "git")
            .ok_or_else(|| "项目选择了内置 Git，但当前安装包中未找到该工具".to_string())?,
    };
    let lfs_program = match settings.lfs_source {
        ToolSource::System => find_in_path("git-lfs"),
        ToolSource::Managed => Some(
            managed_tool(app, "git-lfs")
                .ok_or_else(|| "项目选择了内置 Git LFS，但当前安装包中未找到该工具".to_string())?,
        ),
    };
    let managed_lfs_directory = if settings.lfs_source == ToolSource::Managed {
        lfs_program.as_ref().and_then(|path| path.parent()).map(Path::to_path_buf)
    } else {
        None
    };
    let git_ssh_command = if settings.ssh_source == ToolSource::Managed {
        let ssh = find_in_path("ssh").ok_or_else(|| "系统未找到 ssh".to_string())?;
        let managed_ssh = managed_ssh_directory(app)?;
        let mut command = format!(
            "{} -F {}",
            shell_quote(&ssh),
            shell_quote(&managed_ssh.join("config"))
        );
        if let Some(key) = settings.managed_ssh_key.as_deref() {
            let key = safe_key_name(key)?;
            command.push_str(&format!(
                " -i {} -o IdentitiesOnly=yes",
                shell_quote(&managed_ssh.join("keys").join(key))
            ));
        }
        Some(command)
    } else {
        None
    };
    Ok(ResolvedGitToolchain {
        git_program,
        lfs_program,
        managed_lfs_directory,
        git_ssh_command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names_cannot_escape_managed_directory() {
        assert!(safe_key_name("work_ed25519").is_ok());
        assert!(safe_key_name("../id_rsa").is_err());
        assert!(safe_key_name("key name").is_err());
    }
}
