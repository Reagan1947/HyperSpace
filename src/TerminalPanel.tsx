import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RefreshCw, Trash2 } from "lucide-react";
import {
  APP_SETTINGS_CHANGED_EVENT,
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  terminalCssFontFamily,
  type AppSettings,
} from "./appSettings";
import "@xterm/xterm/css/xterm.css";

type TerminalOutput = {
  sessionId: string;
  data: number[];
};

type TerminalExit = {
  sessionId: string;
};

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function applyTerminalFont(terminal: Terminal, fitAddon: FitAddon, settings: AppSettings) {
  terminal.options.fontFamily = terminalCssFontFamily(settings.terminal.fontFamily);
  terminal.options.fontSize = settings.terminal.fontSize;
  fitAddon.fit();
}

export function TerminalPanel({ projectPath }: { projectPath: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<"starting" | "running" | "exited" | "error">("starting");
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const settingsReady = appSettings !== null;

  useEffect(() => {
    let disposed = false;
    let stopListening: UnlistenFn | undefined;

    void getAppSettings()
      .then((settings) => {
        if (!disposed) setAppSettings(settings);
      })
      .catch(() => {
        if (!disposed) setAppSettings(DEFAULT_APP_SETTINGS);
      });

    void listen<AppSettings>(APP_SETTINGS_CHANGED_EVENT, (event) => {
      setAppSettings(event.payload);
    }).then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      stopListening = stop;
    });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !isTauri() || !appSettings) return;

    const sessionId = crypto.randomUUID();
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: terminalCssFontFamily(appSettings.terminal.fontFamily),
      fontSize: appSettings.terminal.fontSize,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#1f1f1f",
        foreground: "#d8d8d8",
        cursor: "#f3f3f3",
        selectionBackground: "#4b638088",
        black: "#252525",
        brightBlack: "#777777",
        red: "#e06c75",
        brightRed: "#ff7b86",
        green: "#98c379",
        brightGreen: "#b3db8c",
        yellow: "#e5c07b",
        brightYellow: "#f4d58d",
        blue: "#61afef",
        brightBlue: "#78c4ff",
        magenta: "#c678dd",
        brightMagenta: "#dd91f3",
        cyan: "#56b6c2",
        brightCyan: "#70d1dc",
        white: "#d8d8d8",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    fitAddon.fit();
    terminal.focus();
    setStatus("starting");

    let disposed = false;
    let started = false;
    const unlisteners: UnlistenFn[] = [];

    const start = async () => {
      try {
        const stopOutput = await listen<TerminalOutput>("terminal-output", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          terminal.write(new Uint8Array(event.payload.data));
        });
        const stopExit = await listen<TerminalExit>("terminal-exit", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          setStatus("exited");
          terminal.write("\r\n\x1b[90m[进程已退出，点击重启以创建新终端]\x1b[0m\r\n");
        });
        if (disposed) {
          stopOutput();
          stopExit();
          return;
        }
        unlisteners.push(stopOutput, stopExit);

        await invoke("terminal_start", {
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        started = true;
        if (!disposed) {
          setStatus("running");
          terminal.focus();
        }
      } catch (error) {
        if (!disposed) {
          setStatus("error");
          terminal.write(`\r\n\x1b[31m无法启动终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
        }
      }
    };

    const inputDisposable = terminal.onData((data) => {
      writeQueueRef.current = writeQueueRef.current
        .then(() => invoke<void>("terminal_write", { sessionId, data }))
        .catch(() => undefined);
    });

    let resizeTimer = 0;
    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed) return;
        fitAddon.fit();
        if (started) {
          void invoke("terminal_resize", {
            sessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch(() => undefined);
        }
      }, 40);
    });
    resizeObserver.observe(host);
    void start();

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unlisteners.forEach((unlisten) => unlisten());
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      void invoke("terminal_close", { sessionId }).catch(() => undefined);
    };
  }, [generation, projectPath, settingsReady]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon || !appSettings) return;
    applyTerminalFont(terminal, fitAddon, appSettings);
  }, [appSettings]);

  if (!isTauri()) {
    return (
      <div className="terminal-unavailable">
        Terminal 仅在 HyperSpace 桌面应用中可用。
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className={`terminal-status ${status}`} />
        <span>{status === "starting" ? "正在启动" : status === "running" ? "运行中" : status === "exited" ? "已退出" : "启动失败"}</span>
        <code title={projectPath ?? undefined}>{projectPath ?? "应用工作目录"}</code>
        <button type="button" onClick={() => terminalRef.current?.clear()} title="清空终端"><Trash2 size={13} />清空</button>
        <button type="button" onClick={() => setGeneration((value) => value + 1)} title="重启终端"><RefreshCw size={13} />重启</button>
      </div>
      <div className="terminal-host" ref={hostRef} onPointerDown={() => terminalRef.current?.focus()} />
    </div>
  );
}
