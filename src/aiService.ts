import { invoke } from "@tauri-apps/api/core";

export type CursorAuthStatus = {
  status: "logged-in" | "logged-out";
  email?: string;
  apiKeyExpiresAtMs?: number;
};

export type CursorPromptResult = {
  status: "finished";
  agentId: string;
  runId: string;
  result: string;
  model: string;
};

export type CursorModel = {
  id: string;
  displayName: string;
  description?: string;
};

export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

export async function cursorAuthStatus(): Promise<CursorAuthStatus> {
  if (!isTauri()) return { status: "logged-out" };
  return invoke<CursorAuthStatus>("cursor_sdk_request", { request: { action: "status" } });
}

export async function cursorLogin(): Promise<CursorAuthStatus> {
  if (!isTauri()) throw new Error("Cursor SDK 仅在 HyperSpace 桌面端可用");
  return invoke<CursorAuthStatus>("cursor_sdk_request", { request: { action: "login" } });
}

export async function cursorModels(): Promise<CursorModel[]> {
  if (!isTauri()) return [];
  const result = await invoke<{ models: CursorModel[] }>("cursor_sdk_request", { request: { action: "models" } });
  return result.models;
}

export async function cursorPrompt(input: {
  cwd: string;
  prompt: string;
  agentId?: string;
  modelId?: string;
}): Promise<CursorPromptResult> {
  if (!isTauri()) throw new Error("Cursor SDK 仅在 HyperSpace 桌面端可用");
  return invoke<CursorPromptResult>("cursor_sdk_request", {
    request: { action: "prompt", ...input },
  });
}
