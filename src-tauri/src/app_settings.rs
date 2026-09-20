use crate::workspace_store::{write_atomic, ScanOptions};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

pub const APP_SETTINGS_CHANGED_EVENT: &str = "app-settings-changed";
const SETTINGS_FILE: &str = "app-settings.json";
const DEFAULT_TERMINAL_FONT_FAMILY: &str = "JetBrains Mono";
const DEFAULT_TERMINAL_FONT_SIZE: u32 = 12;
const MIN_TERMINAL_FONT_SIZE: u32 = 8;
const MAX_TERMINAL_FONT_SIZE: u32 = 32;
const MAX_VISIBLE_HIDDEN_ENTRIES: usize = 200;
const ALWAYS_HIDDEN_ENTRY: &str = ".hyperspace";
const ALWAYS_VISIBLE_HIDDEN_ENTRY: &str = ".assets";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default = "default_terminal_font_family")]
    pub font_family: String,
    #[serde(default = "default_terminal_font_size")]
    pub font_size: u32,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_family: default_terminal_font_family(),
            font_size: default_terminal_font_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilesSettings {
    #[serde(default = "default_exclude_hidden")]
    pub exclude_hidden: bool,
    #[serde(default)]
    pub visible_hidden_entries: Vec<String>,
}

impl Default for FilesSettings {
    fn default() -> Self {
        Self {
            exclude_hidden: default_exclude_hidden(),
            visible_hidden_entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub files: FilesSettings,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    pub family: String,
    pub monospace: bool,
}

fn default_terminal_font_family() -> String {
    DEFAULT_TERMINAL_FONT_FAMILY.into()
}

fn default_terminal_font_size() -> u32 {
    DEFAULT_TERMINAL_FONT_SIZE
}

fn default_exclude_hidden() -> bool {
    true
}

pub fn normalize_hidden_entry_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let name = if trimmed.starts_with('.') {
        trimmed.to_string()
    } else {
        format!(".{trimmed}")
    };
    if name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == ALWAYS_HIDDEN_ENTRY
        || name == ALWAYS_VISIBLE_HIDDEN_ENTRY
    {
        return None;
    }
    Some(name)
}

pub fn scan_options(app: &AppHandle) -> ScanOptions {
    let settings = load(app).unwrap_or_default();
    ScanOptions::new(
        settings.files.exclude_hidden,
        settings.files.visible_hidden_entries,
    )
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(SETTINGS_FILE))
}

fn clamp_font_size(size: u32) -> u32 {
    size.clamp(MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE)
}

pub fn normalize(mut settings: AppSettings) -> AppSettings {
    let family = settings.terminal.font_family.trim();
    settings.terminal.font_family = if family.is_empty() {
        default_terminal_font_family()
    } else {
        family.to_string()
    };
    settings.terminal.font_size = clamp_font_size(settings.terminal.font_size);

    let mut visible = Vec::new();
    for raw in settings.files.visible_hidden_entries {
        let Some(name) = normalize_hidden_entry_name(&raw) else {
            continue;
        };
        if visible.iter().any(|existing: &String| existing == &name) {
            continue;
        }
        visible.push(name);
        if visible.len() >= MAX_VISIBLE_HIDDEN_ENTRIES {
            break;
        }
    }
    visible.sort_by(|left, right| left.to_ascii_lowercase().cmp(&right.to_ascii_lowercase()));
    settings.files.visible_hidden_entries = visible;
    settings
}

pub fn load(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let settings = serde_json::from_str::<AppSettings>(&raw)
        .map_err(|error| format!("Invalid app settings: {error}"))?;
    Ok(normalize(settings))
}

pub fn save(app: &AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let settings = normalize(settings);
    let payload =
        serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    write_atomic(&settings_path(app)?, &format!("{payload}\n"))?;
    Ok(settings)
}

pub fn list_system_fonts() -> Vec<SystemFont> {
    let mut fonts = native_font_families();
    for family in recommended_monospace_fonts() {
        if !fonts.iter().any(|font| font.family == *family) {
            fonts.push(SystemFont {
                family: family.to_string(),
                monospace: true,
            });
        }
    }

    fonts.sort_by(|left, right| {
        right
            .monospace
            .cmp(&left.monospace)
            .then_with(|| left.family.to_ascii_lowercase().cmp(&right.family.to_ascii_lowercase()))
    });
    fonts.dedup_by(|left, right| left.family.eq_ignore_ascii_case(&right.family));
    fonts
}

fn recommended_monospace_fonts() -> &'static [&'static str] {
    &[
        "JetBrains Mono",
        "SF Mono",
        "Menlo",
        "Monaco",
        "Cascadia Code",
        "Fira Code",
        "Source Code Pro",
        "Hack",
        "Inconsolata",
        "IBM Plex Mono",
        "Iosevka",
        "Maple Mono",
        "Sarasa Mono SC",
        "Sarasa Gothic SC",
        "LXGW WenKai Mono",
        "Ubuntu Mono",
        "Consolas",
        "Courier New",
        "Andale Mono",
        "PT Mono",
    ]
}

fn native_font_families() -> Vec<SystemFont> {
    #[cfg(target_os = "macos")]
    {
        macos_font_families()
    }
    #[cfg(not(target_os = "macos"))]
    {
        recommended_monospace_fonts()
            .iter()
            .map(|family| SystemFont {
                family: (*family).to_string(),
                monospace: true,
            })
            .collect()
    }
}

#[cfg(target_os = "macos")]
fn macos_font_families() -> Vec<SystemFont> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    }

    fn family_is_monospace(family: &str) -> bool {
        if recommended_monospace_fonts()
            .iter()
            .any(|name| name.eq_ignore_ascii_case(family))
        {
            return true;
        }
        let lower = family.to_ascii_lowercase();
        lower.contains("mono")
            || lower.contains("code")
            || lower.contains("console")
            || lower.contains("courier")
            || lower.contains("menlo")
            || lower.contains("monaco")
            || lower.contains("iosevka")
            || lower.contains("inconsolata")
    }

    unsafe {
        let raw = CTFontManagerCopyAvailableFontFamilyNames();
        if raw.is_null() {
            return Vec::new();
        }

        let array = CFArray::<CFString>::wrap_under_create_rule(raw);
        let mut fonts = Vec::with_capacity(array.len() as usize);
        for name in array.iter() {
            let family = name.to_string();
            if family.is_empty() || family.starts_with('.') {
                continue;
            }
            let monospace = family_is_monospace(&family);
            fonts.push(SystemFont { family, monospace });
        }
        fonts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_clamps_font_size_and_fills_empty_family() {
        let settings = normalize(AppSettings {
            terminal: TerminalSettings {
                font_family: "  ".into(),
                font_size: 3,
            },
            ..AppSettings::default()
        });
        assert_eq!(settings.terminal.font_family, DEFAULT_TERMINAL_FONT_FAMILY);
        assert_eq!(settings.terminal.font_size, MIN_TERMINAL_FONT_SIZE);

        let large = normalize(AppSettings {
            terminal: TerminalSettings {
                font_family: "Menlo".into(),
                font_size: 99,
            },
            ..AppSettings::default()
        });
        assert_eq!(large.terminal.font_family, "Menlo");
        assert_eq!(large.terminal.font_size, MAX_TERMINAL_FONT_SIZE);
    }

    #[test]
    fn normalize_hidden_entries_prefix_dedupes_and_drops_invalid() {
        let settings = normalize(AppSettings {
            files: FilesSettings {
                exclude_hidden: true,
                visible_hidden_entries: vec![
                    " gitignore ".into(),
                    ".github".into(),
                    ".gitignore".into(),
                    "../secret".into(),
                    ".hyperspace".into(),
                    ".assets".into(),
                    "".into(),
                ],
            },
            ..AppSettings::default()
        });
        assert_eq!(
            settings.files.visible_hidden_entries,
            vec![".github".to_string(), ".gitignore".to_string()]
        );
        assert!(settings.files.exclude_hidden);
    }

    #[test]
    fn missing_files_settings_default_to_excluding_hidden() {
        let settings: AppSettings = serde_json::from_str(
            r#"{"terminal":{"fontFamily":"Menlo","fontSize":14}}"#,
        )
        .expect("deserialize legacy settings");
        let settings = normalize(settings);
        assert!(settings.files.exclude_hidden);
        assert!(settings.files.visible_hidden_entries.is_empty());
        assert_eq!(settings.terminal.font_family, "Menlo");
    }

    #[test]
    fn list_system_fonts_includes_recommended_monospace() {
        let fonts = list_system_fonts();
        assert!(fonts.iter().any(|font| font.family == "JetBrains Mono" && font.monospace));
        assert!(fonts.iter().any(|font| font.family == "Menlo" && font.monospace));
    }
}
