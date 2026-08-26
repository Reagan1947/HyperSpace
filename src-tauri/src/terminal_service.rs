use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    thread,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

fn lock_sessions(
    state: &TerminalState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalSession>>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态不可用".to_string())
}

fn shell_command(cwd: PathBuf) -> CommandBuilder {
    #[cfg(windows)]
    let mut command = {
        let shell = env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into());
        CommandBuilder::new(shell)
    };

    #[cfg(not(windows))]
    let mut command = {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        command
    };

    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("终端会话 ID 不能为空".into());
    }

    let cwd = super::read_current_project(&app)?
        .filter(|path| path.is_dir())
        .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法创建 PTY：{error}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("无法读取 PTY：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("无法写入 PTY：{error}"))?;
    let child = pair
        .slave
        .spawn_command(shell_command(cwd))
        .map_err(|error| format!("无法启动 shell：{error}"))?;
    drop(pair.slave);

    let session = TerminalSession {
        master: pair.master,
        writer,
        child,
    };
    lock_sessions(&state)?.insert(session_id.clone(), session);

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: session_id.clone(),
                            data: buffer[..count].to_vec(),
                        },
                    );
                }
            }
        }
        let _ = app.emit("terminal-exit", TerminalExit { session_id });
    });

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = lock_sessions(&state)?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "终端会话不存在".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("终端写入失败：{error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = lock_sessions(&state)?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "终端会话不存在".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("终端缩放失败：{error}"))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    lock_sessions(&state)?.remove(&session_id);
    Ok(())
}
