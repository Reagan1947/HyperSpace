import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ChevronDown, ChevronRight, Minus, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  listSystemFonts,
  saveAppSettings,
  terminalCssFontFamily,
  type AppSettings,
  type SystemFont,
} from "./appSettings";
import { loadWorkspace } from "./storage";
import type { TagDefinition } from "./types";
import {
  SETTINGS_NAVIGATE_EVENT,
  TAG_NAME_MAX_LENGTH,
  WORKSPACE_TAGS_CHANGED_EVENT,
  WORKSPACE_TAGS_MUTATE_EVENT,
  WORKSPACE_TAGS_REQUEST_EVENT,
  createTagDefinition,
  findTagByName,
  normalizeTagName,
  type WorkspaceTagsSnapshot,
} from "./workspaceTags";

type SettingsPaneId = "terminal" | "tags";
type SettingsGroupId = "appearance" | "workspace";

type SettingsPane = {
  id: SettingsPaneId;
  title: string;
  description: string;
  keywords: string[];
};

type SettingsGroup = {
  id: SettingsGroupId;
  title: string;
  keywords: string[];
  panes: SettingsPane[];
};

const SETTINGS_PANES: Record<SettingsPaneId, SettingsPane> = {
  terminal: {
    id: "terminal",
    title: "终端",
    description: "字体与显示",
    keywords: ["terminal", "term", "终端", "字体", "font", "字号", "monospace", "等宽"],
  },
  tags: {
    id: "tags",
    title: "标签管理",
    description: "新建、重命名与删除",
    keywords: ["tag", "tags", "标签", "标签管理", "rename", "重命名"],
  },
};

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "appearance",
    title: "外观",
    keywords: ["appearance", "look", "外观", "显示", "display"],
    panes: [SETTINGS_PANES.terminal],
  },
  {
    id: "workspace",
    title: "项目",
    keywords: ["project", "workspace", "项目", "工作区"],
    panes: [SETTINGS_PANES.tags],
  },
];

function paneGroupId(paneId: SettingsPaneId): SettingsGroupId {
  return SETTINGS_GROUPS.find((group) => group.panes.some((pane) => pane.id === paneId))?.id ?? "appearance";
}

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function initialPane(): SettingsPaneId {
  return new URLSearchParams(window.location.search).get("section") === "tags" ? "tags" : "terminal";
}

async function closeWindow() {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().close();
  } catch (error) {
    console.warn("Failed to close Settings window", error);
  }
}

function matchesQuery(pane: SettingsPane, query: string) {
  if (!query) return true;
  const haystack = [pane.title, pane.description, ...pane.keywords].join(" ").toLowerCase();
  return haystack.includes(query);
}

function matchesGroup(group: SettingsGroup, query: string) {
  if (!query) return true;
  const haystack = [group.title, ...group.keywords].join(" ").toLowerCase();
  return haystack.includes(query);
}

function usageLabel(count: number) {
  if (count <= 0) return "未使用";
  return `${count} 处使用`;
}

export function SettingsWindow() {
  const [query, setQuery] = useState("");
  const [activePane, setActivePane] = useState<SettingsPaneId>(initialPane);
  const [openGroups, setOpenGroups] = useState<Record<SettingsGroupId, boolean>>({
    appearance: true,
    workspace: true,
  });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [fonts, setFonts] = useState<SystemFont[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagDefinition[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [newTagName, setNewTagName] = useState("");
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = useMemo(
    () => SETTINGS_GROUPS.map((group) => {
      const groupMatches = matchesGroup(group, normalizedQuery);
      const panes = groupMatches && normalizedQuery
        ? group.panes
        : group.panes.filter((pane) => matchesQuery(pane, normalizedQuery));
      return { ...group, panes };
    }).filter((group) => group.panes.length > 0),
    [normalizedQuery],
  );
  const visiblePanes = useMemo(
    () => visibleGroups.flatMap((group) => group.panes),
    [visibleGroups],
  );

  const toggleGroup = (groupId: SettingsGroupId) => {
    setOpenGroups((current) => ({ ...current, [groupId]: !current[groupId] }));
  };

  const selectPane = (paneId: SettingsPaneId) => {
    setActivePane(paneId);
    setOpenGroups((current) => ({ ...current, [paneGroupId(paneId)]: true }));
  };

  useEffect(() => {
    document.documentElement.classList.add("settings-window");
    document.body.classList.add("settings-window");
    return () => {
      document.documentElement.classList.remove("settings-window");
      document.body.classList.remove("settings-window");
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editingTagId) {
        event.preventDefault();
        void closeWindow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingTagId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAppSettings(), listSystemFonts()])
      .then(([loaded, systemFonts]) => {
        if (cancelled) return;
        setSettings(loaded);
        setFonts(systemFonts);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspace()
      .then((workspace) => {
        if (cancelled || !workspace) return;
        setTags(workspace.tags ?? []);
        const nextUsage: Record<string, number> = {};
        for (const tag of workspace.tags ?? []) nextUsage[tag.id] = 0;
        for (const node of workspace.nodes) {
          for (const tagId of node.tagIds ?? []) {
            nextUsage[tagId] = (nextUsage[tagId] ?? 0) + 1;
          }
        }
        setUsage(nextUsage);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setTagError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void import("@tauri-apps/api/event").then(async ({ emit, listen }) => {
      if (disposed) return;
      const stopNavigate = await listen<string>(SETTINGS_NAVIGATE_EVENT, (event) => {
        if (event.payload === "tags" || event.payload === "terminal") {
          const paneId = event.payload;
          setActivePane(paneId);
          setOpenGroups((current) => ({ ...current, [paneGroupId(paneId)]: true }));
          setQuery("");
        }
      });
      const stopTags = await listen<WorkspaceTagsSnapshot>(WORKSPACE_TAGS_CHANGED_EVENT, (event) => {
        if (!event.payload?.tags) return;
        setTags(event.payload.tags);
        setUsage(event.payload.usage ?? {});
      });
      if (disposed) {
        stopNavigate();
        stopTags();
        return;
      }
      unlisteners.push(stopNavigate, stopTags);
      void emit(WORKSPACE_TAGS_REQUEST_EVENT);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (visiblePanes.length === 0) return;
    if (!visiblePanes.some((pane) => pane.id === activePane)) {
      setActivePane(visiblePanes[0].id);
    }
  }, [activePane, visiblePanes]);

  const persist = async (next: AppSettings) => {
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await saveAppSettings(next);
      setSettings(saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const updateTerminal = (patch: Partial<AppSettings["terminal"]>) => {
    void persist({
      ...settings,
      terminal: { ...settings.terminal, ...patch },
    });
  };

  const persistTags = async (nextTags: TagDefinition[], removedTagIds: string[] = []) => {
    setTags(nextTags);
    setUsage((current) => {
      const next = { ...current };
      for (const id of removedTagIds) delete next[id];
      for (const tag of nextTags) {
        if (next[tag.id] == null) next[tag.id] = 0;
      }
      return next;
    });
    setTagError(null);
    if (!isTauri()) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(WORKSPACE_TAGS_MUTATE_EVENT, { tags: nextTags, removedTagIds });
    } catch (mutateError) {
      setTagError(mutateError instanceof Error ? mutateError.message : String(mutateError));
    }
  };

  const createTag = () => {
    const name = normalizeTagName(newTagName);
    if (!name) return;
    if (findTagByName(tags, name)) {
      setTagError(`标签“${name}”已存在`);
      return;
    }
    const tag = createTagDefinition(name);
    setNewTagName("");
    void persistTags([...tags, tag]);
  };

  const startRename = (tag: TagDefinition) => {
    setEditingTagId(tag.id);
    setEditingName(tag.name);
    setTagError(null);
  };

  const cancelRename = () => {
    setEditingTagId(null);
    setEditingName("");
  };

  const commitRename = (tag: TagDefinition) => {
    const name = normalizeTagName(editingName);
    if (!name || name === tag.name) {
      cancelRename();
      return;
    }
    const duplicate = findTagByName(tags, name);
    if (duplicate && duplicate.id !== tag.id) {
      setTagError(`标签“${name}”已存在`);
      return;
    }
    cancelRename();
    void persistTags(tags.map((item) => item.id === tag.id ? { ...item, name } : item));
  };

  const removeTag = (tag: TagDefinition) => {
    const used = usage[tag.id] ?? 0;
    const message = used > 0
      ? `确定删除标签“${tag.name}”吗？该标签会从 ${used} 个文件或笔记中移除。`
      : `确定删除标签“${tag.name}”吗？`;
    if (!window.confirm(message)) return;
    if (editingTagId === tag.id) cancelRename();
    void persistTags(tags.filter((item) => item.id !== tag.id), [tag.id]);
  };

  const fontOptions = useMemo(() => {
    const options = [...fonts];
    if (settings.terminal.fontFamily && !options.some((font) => font.family === settings.terminal.fontFamily)) {
      options.unshift({ family: settings.terminal.fontFamily, monospace: true });
    }
    return options;
  }, [fonts, settings.terminal.fontFamily]);

  const monospaceFonts = fontOptions.filter((font) => font.monospace);
  const otherFonts = fontOptions.filter((font) => !font.monospace);
  const previewFamily = terminalCssFontFamily(settings.terminal.fontFamily);
  const paneVisible = visiblePanes.some((pane) => pane.id === activePane);
  const footerError = activePane === "tags" ? tagError : error;
  const footerMessage = activePane === "tags"
    ? "标签已同步到当前项目"
    : saving ? "正在保存…" : "更改已自动保存";

  return (
    <div className="settings-window-shell">
      <aside className="settings-sidebar">
        <label className="settings-search">
          <Search size={13} strokeWidth={2} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设置"
            autoFocus={activePane !== "tags"}
            spellCheck={false}
          />
        </label>
        <nav className="settings-nav" aria-label="设置项" role="tree">
          {visibleGroups.length === 0 ? (
            <p className="settings-empty">没有匹配的设置</p>
          ) : (
            visibleGroups.map((group) => {
              const expanded = Boolean(normalizedQuery) || openGroups[group.id];
              return (
                <div key={group.id} className="settings-tree-group" role="group" aria-label={group.title}>
                  <button
                    type="button"
                    className="tree-item settings-tree-folder"
                    role="treeitem"
                    aria-expanded={expanded}
                    title={group.title}
                    onClick={() => {
                      if (normalizedQuery) return;
                      toggleGroup(group.id);
                    }}
                  >
                    <span className="tree-chevron visible">
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </span>
                    <span className="tree-label">{group.title}</span>
                  </button>
                  {expanded && group.panes.map((pane) => {
                    const selected = pane.id === activePane;
                    return (
                      <button
                        key={pane.id}
                        type="button"
                        className={`tree-item settings-tree-leaf ${selected ? "selected" : ""}`}
                        role="treeitem"
                        aria-selected={selected}
                        title={pane.title}
                        onClick={() => selectPane(pane.id)}
                      >
                        <span className="tree-label">{pane.title}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </nav>
      </aside>

      <section className="settings-content">
        {activePane === "terminal" && paneVisible ? (
          <>
            <header className="settings-pane-header">
              <h2>终端</h2>
              <p>设置内置终端的字体与字号，修改后立即生效。</p>
            </header>

            <div className="settings-group">
              <label className="settings-field">
                <span>字体</span>
                <select
                  value={settings.terminal.fontFamily}
                  onChange={(event) => updateTerminal({ fontFamily: event.target.value })}
                >
                  {monospaceFonts.length > 0 && (
                    <optgroup label="等宽字体">
                      {monospaceFonts.map((font) => (
                        <option key={font.family} value={font.family} style={{ fontFamily: `"${font.family}"` }}>
                          {font.family}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {otherFonts.length > 0 && (
                    <optgroup label="所有字体">
                      {otherFonts.map((font) => (
                        <option key={font.family} value={font.family} style={{ fontFamily: `"${font.family}"` }}>
                          {font.family}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>

              <label className="settings-field">
                <span>字号</span>
                <div className="settings-stepper">
                  <button
                    type="button"
                    aria-label="减小字号"
                    disabled={settings.terminal.fontSize <= 8}
                    onClick={() => updateTerminal({ fontSize: settings.terminal.fontSize - 1 })}
                  >
                    <Minus size={12} />
                  </button>
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={settings.terminal.fontSize}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next)) updateTerminal({ fontSize: next });
                    }}
                  />
                  <button
                    type="button"
                    aria-label="增大字号"
                    disabled={settings.terminal.fontSize >= 32}
                    onClick={() => updateTerminal({ fontSize: settings.terminal.fontSize + 1 })}
                  >
                    <Plus size={12} />
                  </button>
                  <span className="settings-stepper-unit">px</span>
                </div>
              </label>
            </div>

            <div className="settings-preview" aria-label="终端字体预览">
              <span>预览</span>
              <pre style={{ fontFamily: previewFamily, fontSize: `${settings.terminal.fontSize}px` }}>
{`~/HyperSpace $ ls
README.md    src    src-tauri
~/HyperSpace $ echo "AaBb 0123 终端字体"`}
              </pre>
            </div>
          </>
        ) : activePane === "tags" && paneVisible ? (
          <>
            <header className="settings-pane-header">
              <h2>标签管理</h2>
              <p>管理当前项目的标签。重命名会同步到所有已使用该标签的内容，删除会从文件和笔记中移除。</p>
            </header>

            <form
              className="settings-tag-create"
              onSubmit={(event) => {
                event.preventDefault();
                createTag();
              }}
            >
              <input
                value={newTagName}
                maxLength={TAG_NAME_MAX_LENGTH}
                placeholder="新建标签"
                aria-label="新标签名称"
                autoFocus={activePane === "tags"}
                onChange={(event) => {
                  setNewTagName(event.target.value);
                  if (tagError) setTagError(null);
                }}
              />
              <button type="submit" disabled={!normalizeTagName(newTagName)}>
                <Plus size={13} />
                添加
              </button>
            </form>

            {tags.length === 0 ? (
              <div className="settings-tag-empty">还没有标签。创建一个后，即可在文件树中为笔记和文件打标。</div>
            ) : (
              <div className="settings-tag-list" role="list" aria-label="项目标签">
                {tags.map((tag) => {
                  const editing = editingTagId === tag.id;
                  const used = usage[tag.id] ?? 0;
                  return (
                    <div key={tag.id} className={`settings-tag-row ${editing ? "editing" : ""}`} role="listitem">
                      {editing ? (
                        <input
                          className="settings-tag-rename"
                          value={editingName}
                          maxLength={TAG_NAME_MAX_LENGTH}
                          autoFocus
                          aria-label={`重命名标签 ${tag.name}`}
                          onChange={(event) => setEditingName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename(tag);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelRename();
                            }
                          }}
                          onBlur={() => commitRename(tag)}
                        />
                      ) : (
                        <span className="settings-tag-name" title={tag.name}>{tag.name}</span>
                      )}
                      <span className="settings-tag-usage">{usageLabel(used)}</span>
                      {editing ? (
                        <>
                          <button type="button" aria-label={`保存标签 ${tag.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commitRename(tag)}>
                            <Check size={13} />
                          </button>
                          <button type="button" aria-label="取消重命名" onMouseDown={(event) => event.preventDefault()} onClick={cancelRename}>
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" aria-label={`重命名标签 ${tag.name}`} title="重命名" onClick={() => startRename(tag)}>
                            <Pencil size={12} />
                          </button>
                          <button type="button" className="danger" aria-label={`删除标签 ${tag.name}`} title="删除" onClick={() => removeTag(tag)}>
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="settings-content-empty">没有可显示的设置</div>
        )}

        <footer className="settings-status">
          {footerError ? <p className="modal-error" role="alert">{footerError}</p> : <span>{footerMessage}</span>}
        </footer>
      </section>
    </div>
  );
}
