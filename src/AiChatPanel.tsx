import { useEffect, useMemo, useState } from "react";
import { ChevronDown, LogIn, Maximize2, Minimize2, Minus, PanelRightOpen, Plus, Settings, Sparkles, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import chatAiIcon from "./assets/icons/chat-ai-line.svg";
import cursorCubeIcon from "./assets/icons/cursor-cube.svg";
import sendUpIcon from "./assets/icons/send-up.svg";
import { cursorAuthStatus, cursorLogin, cursorModels, cursorPrompt, type AiMessage, type CursorAuthStatus, type CursorModel } from "./aiService";

type ChatSession = { id: string; title: string; agentId?: string; modelId?: string; messages: AiMessage[]; updatedAt: number };
type ChatAttachment = { name: string; path: string };
const newSession = (modelId?: string): ChatSession => ({ id: crypto.randomUUID(), title: "新对话", modelId, messages: [], updatedAt: Date.now() });
const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;

export function AiChatPanel({ projectPath, pageTitle, pageMarkdown, onMinimize, onToggleWorkspace, workspaceMode = false }: { projectPath: string | null; pageTitle: string; pageMarkdown: string; onMinimize: () => void; onToggleWorkspace?: () => void; workspaceMode?: boolean }) {
  const [auth, setAuth] = useState<CursorAuthStatus | null>(null);
  const [models, setModels] = useState<CursorModel[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<"history" | "settings" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const storageKey = useMemo(() => projectPath ? `hyperspace:cursor-chats:${projectPath}` : "hyperspace:cursor-chats:default", [projectPath]);
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];

  useEffect(() => { void cursorAuthStatus().then(setAuth).catch((reason) => setError(String(reason))); }, []);
  useEffect(() => {
    if (auth?.status !== "logged-in") return;
    void cursorModels().then((available) => {
      setModels(available);
      const preferred = available.find((model) => model.id === "composer-2.5")?.id ?? available[0]?.id;
      setSessions((current) => current.map((session) => session.modelId ? session : { ...session, modelId: preferred }));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [auth?.status]);
  useEffect(() => {
    let loaded: ChatSession[] = [];
    if (storageKey) try { loaded = JSON.parse(localStorage.getItem(storageKey) ?? "[]"); } catch { loaded = []; }
    if (!loaded.length) loaded = [newSession()];
    setSessions(loaded); setActiveId(loaded[0].id);
  }, [storageKey]);
  useEffect(() => { if (storageKey && sessions.length) localStorage.setItem(storageKey, JSON.stringify(sessions)); }, [sessions, storageKey]);

  const selectModel = (modelId: string) => setSessions((current) => current.map((session) => session.id === active?.id ? { ...session, modelId, agentId: undefined } : session));
  const createChat = () => { const session = newSession(active?.modelId ?? models[0]?.id); setSessions((current) => [session, ...current]); setActiveId(session.id); setMenu(null); setError(undefined); };
  async function login() { setBusy(true); setError(undefined); try { setAuth(await cursorLogin()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  async function attachFiles() {
    try {
      const selected = await open({ multiple: true, title: "添加附件" });
      if (selected == null) return;
      const paths = (Array.isArray(selected) ? selected : [selected]).filter(Boolean);
      setAttachments((current) => {
        const next = [...current];
        for (const path of paths) {
          if (!next.some((item) => item.path === path)) next.push({ path, name: fileName(path) });
        }
        return next;
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function send() {
    const trimmed = input.trim(); if (!trimmed || !projectPath || busy || !active) return;
    const attached = attachments;
    const sessionId = active.id; const userMessage: AiMessage = { id: crypto.randomUUID(), role: "user", text: trimmed };
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, title: session.messages.length ? session.title : trimmed.slice(0, 28), messages: [...session.messages, userMessage], updatedAt: Date.now() } : session));
    setInput(""); setAttachments([]); setBusy(true); setError(undefined);
    try {
      const pageContext = pageMarkdown ? `\n\n当前页面：${pageTitle}\n---\n${pageMarkdown.slice(0, 12_000)}` : `\n\n当前视图：${pageTitle || "工作空间"}`;
      const attachmentContext = attached.length ? `\n\n附件：\n${attached.map((file) => `- ${file.path}`).join("\n")}` : "";
      const result = await cursorPrompt({ cwd: projectPath, agentId: active.agentId, modelId: active.modelId, prompt: `${trimmed}${pageContext}${attachmentContext}` });
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, agentId: result.agentId, modelId: result.model, messages: [...session.messages, { id: result.runId, role: "assistant", text: result.result || "Cursor Agent 已完成，但没有返回文本。" }], updatedAt: Date.now() } : session));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }

  return <div className="ai-chat">
    <header className="ai-chat-toolbar">
      <div className="ai-chat-toolbar-left">
        <img className="ai-chat-title-icon" src={chatAiIcon} alt="" aria-hidden="true" />
        <button type="button" className={`ai-history-trigger ${menu === "history" ? "active" : ""}`} onClick={() => setMenu((value) => value === "history" ? null : "history")} aria-haspopup="menu" aria-expanded={menu === "history"}>
          <span>Chat History</span><ChevronDown size={13} />
        </button>
      </div>
      <div className="ai-chat-toolbar-actions">
        <button type="button" className="ai-new-chat" onClick={createChat} title="新增 Chat"><Plus size={15} /><span>New Chat</span></button>
        {onToggleWorkspace && <button type="button" onClick={onToggleWorkspace} title={workspaceMode ? "还原到侧边栏" : "在编辑区打开 Chat"} aria-label={workspaceMode ? "还原到侧边栏" : "在编辑区打开 Chat"}><PanelRightOpen size={15} /></button>}
        <i className="ai-toolbar-divider" aria-hidden="true" />
        <button type="button" className={menu === "settings" ? "active" : ""} onClick={() => setMenu((value) => value === "settings" ? null : "settings")} title="AI 设置"><Settings size={14} /></button>
        <button type="button" onClick={onMinimize} title="最小化"><Minus size={15} /></button>
      </div>
    </header>
    {menu === "history" && <div className="ai-popover ai-history"><strong>Chat 历史</strong>{sessions.map((session) => <button type="button" key={session.id} className={session.id === active?.id ? "active" : ""} onClick={() => { setActiveId(session.id); setMenu(null); }}><span>{session.title}</span><small>{new Date(session.updatedAt).toLocaleDateString()}</small></button>)}</div>}
    {menu === "settings" && <div className="ai-popover ai-settings"><p>模型选择已移至输入框下方。切换模型后，下一条消息会开始新的 Agent 上下文。</p></div>}
    {auth?.status !== "logged-in" ? <div className="ai-empty-card"><span className="ai-icon"><Sparkles size={17} /></span><strong>连接 Cursor</strong><p>使用 Cursor Agent 理解当前页面和项目文件。</p><button type="button" onClick={() => void login()} disabled={busy}><LogIn size={14} />{busy ? "等待浏览器授权…" : "登录 Cursor"}</button></div> : <>
      <div className="ai-messages" aria-live="polite">{active?.messages.map((message) => <div key={message.id} className={`ai-message ${message.role}`}>{message.text}</div>)}{busy && <div className="ai-message assistant pending">Cursor Agent 正在思考…</div>}</div>
      {!workspaceMode && onToggleWorkspace && <aside className="ai-editor-hint">
        <strong>More room for your prompts</strong>
        <p>Chat can now open as editor tab.</p>
        <p>Split or drag it to sit next to code.</p>
        <button type="button" onClick={onToggleWorkspace}>Open Chat in Editor</button>
      </aside>}
      <div className={`ai-composer ${expanded ? "expanded" : ""}`}>
        {attachments.length > 0 && <ul className="ai-composer-files">{attachments.map((file) => <li key={file.path}><span title={file.path}>{file.name}</span><button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))} aria-label={`移除 ${file.name}`}><X size={11} /></button></li>)}</ul>}
        <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={projectPath ? "询问当前页面或项目…" : "请先打开本地项目"} disabled={!projectPath || busy} rows={expanded ? 8 : 3} />
          <button type="button" className="ai-composer-expand" onClick={() => setExpanded((value) => !value)} title={expanded ? "收起输入框" : "展开输入框"} aria-label={expanded ? "收起输入框" : "展开输入框"}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          <button type="button" className="ai-composer-attach" onClick={() => void attachFiles()} disabled={!projectPath || busy} title="添加附件" aria-label="添加附件"><Plus size={15} /></button>
          <button type="submit" className="ai-composer-send" disabled={!input.trim() || !projectPath || busy} aria-label="发送"><img src={sendUpIcon} alt="" /></button>
        </form>
        <div className="ai-composer-meta">
          <span className="ai-cursor-brand"><img src={cursorCubeIcon} alt="" aria-hidden="true" />Cursor</span>
          <select aria-label="选择模型" value={active?.modelId ?? ""} onChange={(event) => selectModel(event.target.value)} disabled={!models.length}>
            {models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>) : <option>加载模型中…</option>}
          </select>
        </div>
      </div>
    </>}{error && <p className="ai-error">{error}</p>}
  </div>;
}

export function AiHistoryManager({ projectPath, onOpenChat }: { projectPath: string | null; onOpenChat: () => void }) {
  const storageKey = useMemo(() => projectPath ? `hyperspace:cursor-chats:${projectPath}` : "hyperspace:cursor-chats:default", [projectPath]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  useEffect(() => {
    try { setSessions(JSON.parse(localStorage.getItem(storageKey) ?? "[]")); }
    catch { setSessions([]); }
  }, [storageKey]);

  return <section className="ai-history-manager" aria-label="Chat History 管理">
    <header><strong>Chat History</strong><button type="button" onClick={onOpenChat}><PanelRightOpen size={14} /><span>打开 Chat</span></button></header>
    <div className="ai-history-manager-list">
      {sessions.length ? sessions.sort((a, b) => b.updatedAt - a.updatedAt).map((session) => <button key={session.id} type="button" onClick={onOpenChat}>
        <span>{session.title}</span><small>{new Date(session.updatedAt).toLocaleString()}</small>
      </button>) : <p>暂无 Chat 记录。开始新对话后，记录会保存在这里。</p>}
    </div>
  </section>;
}
