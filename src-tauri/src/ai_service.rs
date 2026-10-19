use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Write, path::PathBuf, process::{Command, Stdio}};
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSdkRequest {
    pub action: String,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub agent_id: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest<'a> {
    action: &'a str,
    cwd: Option<&'a str>,
    prompt: Option<&'a str>,
    agent_id: Option<&'a str>,
    model_id: Option<&'a str>,
}

fn helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app.path().resource_dir().map_err(|error| error.to_string())?
        .join("cursor-agent.cjs");
    if bundled.exists() {
        return Ok(bundled);
    }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/cursor-agent.mjs"))
}

#[tauri::command]
pub async fn cursor_sdk_request(app: AppHandle, request: CursorSdkRequest) -> Result<Value, String> {
    let helper = helper_path(&app)?;
    let payload = serde_json::to_vec(&HelperRequest {
        action: &request.action,
        cwd: request.cwd.as_deref(),
        prompt: request.prompt.as_deref(),
        agent_id: request.agent_id.as_deref(),
        model_id: request.model_id.as_deref(),
    }).map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("node")
            .arg(helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 Cursor SDK。请确认已安装 Node.js 22.13+：{error}"))?;
        child.stdin.as_mut().ok_or("无法连接 Cursor SDK 输入")?
            .write_all(&payload).map_err(|error| error.to_string())?;
        let output = child.wait_with_output().map_err(|error| error.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let response: Value = serde_json::from_str(stdout.lines().last().unwrap_or(""))
            .map_err(|_| format!("Cursor SDK 返回了无效响应：{}", String::from_utf8_lossy(&output.stderr)))?;
        if !output.status.success() || response.get("status").and_then(Value::as_str) == Some("error") {
            return Err(response.get("error").and_then(Value::as_str)
                .unwrap_or("Cursor SDK 请求失败").to_string());
        }
        Ok(response)
    }).await.map_err(|error| error.to_string())?
}
