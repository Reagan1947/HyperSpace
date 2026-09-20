import { invoke } from "@tauri-apps/api/core";

export const APP_SETTINGS_CHANGED_EVENT = "app-settings-changed";

export type TerminalSettings = {
  fontFamily: string;
  fontSize: number;
};

export type AppSettings = {
  terminal: TerminalSettings;
};

export type SystemFont = {
  family: string;
  monospace: boolean;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  terminal: {
    fontFamily: "JetBrains Mono",
    fontSize: 12,
  },
};

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

export function terminalCssFontFamily(family: string) {
  const trimmed = family.trim() || DEFAULT_APP_SETTINGS.terminal.fontFamily;
  if (trimmed.toLowerCase() === "monospace") {
    return "Menlo, Monaco, \"SFMono-Regular\", Consolas, monospace";
  }
  return `"${trimmed}", "SFMono-Regular", Menlo, Monaco, Consolas, monospace`;
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!isTauri()) return structuredClone(DEFAULT_APP_SETTINGS);
  return invoke<AppSettings>("get_app_settings");
}

export async function saveAppSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isTauri()) return settings;
  return invoke<AppSettings>("save_app_settings", { settings });
}

export async function listSystemFonts(): Promise<SystemFont[]> {
  if (!isTauri()) {
    return [{ family: DEFAULT_APP_SETTINGS.terminal.fontFamily, monospace: true }];
  }
  return invoke<SystemFont[]>("list_system_fonts");
}
