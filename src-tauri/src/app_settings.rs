use crate::workspace_store::write_atomic;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

pub const APP_SETTINGS_CHANGED_EVENT: &str = "app-settings-changed";
const SETTINGS_FILE: &str = "app-settings.json";
const DEFAULT_TERMINAL_FONT_FAMILY: &str = "JetBrains Mono";
const DEFAULT_TERMINAL_FONT_SIZE: u32 = 12;
const MIN_TERMINAL_FONT_SIZE: u32 = 8;
const MAX_TERMINAL_FONT_SIZE: u32 = 32;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub terminal: TerminalSettings,
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
        });
        assert_eq!(settings.terminal.font_family, DEFAULT_TERMINAL_FONT_FAMILY);
        assert_eq!(settings.terminal.font_size, MIN_TERMINAL_FONT_SIZE);

        let large = normalize(AppSettings {
            terminal: TerminalSettings {
                font_family: "Menlo".into(),
                font_size: 99,
            },
        });
        assert_eq!(large.terminal.font_family, "Menlo");
        assert_eq!(large.terminal.font_size, MAX_TERMINAL_FONT_SIZE);
    }

    #[test]
    fn list_system_fonts_includes_recommended_monospace() {
        let fonts = list_system_fonts();
        assert!(fonts.iter().any(|font| font.family == "JetBrains Mono" && font.monospace));
        assert!(fonts.iter().any(|font| font.family == "Menlo" && font.monospace));
    }
}
