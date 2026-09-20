use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::workspace_store;

struct LaunchSpec {
    program: &'static str,
    args: Vec<OsString>,
}

fn spawn(spec: LaunchSpec) -> Result<(), String> {
    Command::new(spec.program)
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开：{error}"))
}

fn directory_for_terminal(path: &Path) -> Result<PathBuf, String> {
    if path.is_dir() {
        return Ok(path.to_path_buf());
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法确定终端工作目录".into())
}

fn finder_command(path: &Path) -> LaunchSpec {
    #[cfg(target_os = "macos")]
    {
        let mut args = Vec::new();
        if !path.is_dir() {
            args.push(OsString::from("-R"));
        }
        args.push(path.as_os_str().to_os_string());
        LaunchSpec {
            program: "open",
            args,
        }
    }

    #[cfg(target_os = "windows")]
    {
        if path.is_dir() {
            LaunchSpec {
                program: "explorer",
                args: vec![path.as_os_str().to_os_string()],
            }
        } else {
            let mut select = OsString::from("/select,");
            select.push(path.as_os_str());
            LaunchSpec {
                program: "explorer",
                args: vec![select],
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        LaunchSpec {
            program: "xdg-open",
            args: vec![target.as_os_str().to_os_string()],
        }
    }
}

fn terminal_command(directory: &Path) -> LaunchSpec {
    #[cfg(target_os = "macos")]
    {
        LaunchSpec {
            program: "open",
            args: vec![
                OsString::from("-a"),
                OsString::from("Terminal"),
                directory.as_os_str().to_os_string(),
            ],
        }
    }

    #[cfg(target_os = "windows")]
    {
        LaunchSpec {
            program: "cmd",
            args: vec![
                OsString::from("/K"),
                OsString::from("cd"),
                OsString::from("/D"),
                directory.as_os_str().to_os_string(),
            ],
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        LaunchSpec {
            program: "x-terminal-emulator",
            args: vec![
                OsString::from("--working-directory"),
                directory.as_os_str().to_os_string(),
            ],
        }
    }
}

pub fn reveal_in_finder(project_path: &Path, local_path: &str) -> Result<(), String> {
    let path = workspace_store::resolve_existing_project_path(project_path, local_path)
        .map_err(|error| format!("无法在 Finder 中打开：{error}"))?;
    spawn(finder_command(&path)).map_err(|error| format!("无法在 Finder 中打开：{error}"))
}

pub fn open_in_terminal(project_path: &Path, local_path: &str) -> Result<(), String> {
    let path = workspace_store::resolve_existing_project_path(project_path, local_path)
        .map_err(|error| format!("无法在终端打开：{error}"))?;
    let directory = directory_for_terminal(&path)?;
    spawn(terminal_command(&directory)).map_err(|error| format!("无法在终端打开：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    fn test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("hyperspace-fs-open-{name}-{unique}"))
    }

    #[test]
    fn finder_opens_directories_and_reveals_files() {
        let project = test_directory("finder");
        fs::create_dir_all(&project).expect("create project");
        let file = project.join("note.md");
        fs::write(&file, "body").expect("write file");

        let dir_command = finder_command(&project);
        let file_command = finder_command(&file);

        #[cfg(target_os = "macos")]
        {
            assert_eq!(dir_command.program, "open");
            assert_eq!(dir_command.args, vec![project.as_os_str().to_os_string()]);
            assert_eq!(file_command.program, "open");
            assert_eq!(
                file_command.args,
                vec![OsString::from("-R"), file.as_os_str().to_os_string()]
            );
        }

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn terminal_uses_parent_directory_for_files() {
        let project = test_directory("terminal");
        fs::create_dir_all(project.join("docs")).expect("create docs");
        let file = project.join("docs/note.md");
        fs::write(&file, "body").expect("write file");

        let directory = directory_for_terminal(&file).expect("parent directory");
        assert_eq!(directory, project.join("docs"));
        assert_eq!(
            directory_for_terminal(&project.join("docs")).expect("folder"),
            project.join("docs")
        );

        let command = terminal_command(&directory);
        #[cfg(target_os = "macos")]
        {
            assert_eq!(command.program, "open");
            assert_eq!(
                command.args,
                vec![
                    OsString::from("-a"),
                    OsString::from("Terminal"),
                    directory.as_os_str().to_os_string(),
                ]
            );
        }

        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn resolve_rejects_paths_outside_the_project() {
        let project = test_directory("sandbox");
        fs::create_dir_all(&project).expect("create project");
        fs::write(project.join("inside.md"), "ok").expect("write file");

        let inside = workspace_store::resolve_existing_project_path(&project, "inside.md")
            .expect("inside path");
        assert_eq!(inside, fs::canonicalize(project.join("inside.md")).expect("canonicalize"));

        let root = workspace_store::resolve_existing_project_path(&project, "")
            .expect("project root");
        assert_eq!(root, fs::canonicalize(&project).expect("canonicalize project"));

        workspace_store::resolve_existing_project_path(&project, "../outside.md")
            .expect_err("reject parent path");
        workspace_store::resolve_existing_project_path(&project, "/tmp")
            .expect_err("reject absolute path");

        fs::remove_dir_all(project).expect("remove temp project");
    }
}
