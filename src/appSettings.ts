import { invoke } from "@tauri-apps/api/core";

export const APP_SETTINGS_CHANGED_EVENT = "app-settings-changed";
export const ALWAYS_HIDDEN_ENTRY = ".hyperspace";
export const ALWAYS_VISIBLE_HIDDEN_ENTRY = ".assets";

export type TerminalSettings = {
  fontFamily: string;
  fontSize: number;
};

export type FilesSettings = {
  excludeHidden: boolean;
  visibleHiddenEntries: string[];
};

export type AppSettings = {
  terminal: TerminalSettings;
  files: FilesSettings;
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
  files: {
    excludeHidden: true,
    visibleHiddenEntries: [],
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

export function normalizeHiddenEntryName(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const name = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  if (
    name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
  ) {
    return null;
  }
  return name;
}

export function hiddenEntryNameError(raw: string, existing: string[] = []) {
  const name = normalizeHiddenEntryName(raw);
  if (!name) {
    return raw.trim() ? "请输入文件或文件夹名称，不能包含路径" : "请输入要显示的隐藏文件或文件夹名称";
  }
  if (name === ALWAYS_HIDDEN_ENTRY) {
    return ".hyperspace 是应用内部目录，不会出现在文件树中";
  }
  if (name === ALWAYS_VISIBLE_HIDDEN_ENTRY) {
    return ".assets 始终会显示，无需添加";
  }
  if (existing.some((item) => item === name)) {
    return `“${name}”已在列表中`;
  }
  return null;
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!isTauri()) return structuredClone(DEFAULT_APP_SETTINGS);
  const loaded = await invoke<AppSettings>("get_app_settings");
  return {
    terminal: { ...DEFAULT_APP_SETTINGS.terminal, ...loaded.terminal },
    files: {
      excludeHidden: loaded.files?.excludeHidden ?? DEFAULT_APP_SETTINGS.files.excludeHidden,
      visibleHiddenEntries: loaded.files?.visibleHiddenEntries ?? [],
    },
  };
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
