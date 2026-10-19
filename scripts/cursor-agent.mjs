import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, Cursor, JsonlLocalAgentStore } from "@cursor/sdk";

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function pickModel(requestedId) {
  const models = await Cursor.models.list();
  const requested = requestedId ? models.find((model) => model.id === requestedId) : undefined;
  const preferred = ["composer-2.5", "auto-smart"];
  const selected = requested
    ?? preferred.map((id) => models.find((model) => model.id === id)).find(Boolean)
    ?? models[0];
  if (!selected) return undefined;
  if (selected.id === "auto-smart") {
    return { id: selected.id, params: [{ id: "optimize_for", value: "balanced" }] };
  }
  return { id: selected.id };
}

async function main() {
  const request = await readRequest();
  const store = new JsonlLocalAgentStore(join(homedir(), ".cursor", "hyperspace-sdk"));
  Cursor.configure({ local: { store } });

  if (request.action === "status") {
    write(await Cursor.auth.status());
    return;
  }

  if (request.action === "login") {
    const login = await Cursor.auth.login({ apiKeyName: "HyperSpace Desktop" });
    write({ status: "logged-in", email: login.email, apiKeyExpiresAtMs: login.apiKeyExpiresAtMs });
    return;
  }

  if (request.action === "models") {
    const models = await Cursor.models.list();
    write({ models: models.map(({ id, displayName, description }) => ({ id, displayName, description })) });
    return;
  }

  if (request.action !== "prompt") throw new Error("Unsupported Cursor SDK action");
  if (!request.cwd || !request.prompt) throw new Error("Project path and prompt are required");

  const model = await pickModel(request.modelId);
  if (!model) throw new Error("Cursor account has no available models");

  const options = {
    model,
    tools: ["read", "grep", "glob", "ls", "semSearch"],
    local: { cwd: request.cwd, store, sandboxOptions: { enabled: true } },
  };

  let agent;
  if (request.agentId) {
    try {
      agent = await Agent.resume(request.agentId, options);
    } catch {
      agent = await Agent.create(options);
    }
  } else {
    agent = await Agent.create(options);
  }

  try {
    const run = await agent.send(request.prompt);
    const result = await run.wait();
    if (result.status !== "finished") {
      throw new Error(result.error?.message ?? `Cursor run ended with status ${result.status}`);
    }
    write({
      status: "finished",
      agentId: agent.agentId,
      runId: result.id,
      result: result.result ?? "",
      model: result.model?.id ?? model.id,
      usage: result.usage,
    });
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

main().catch((error) => {
  write({ status: "error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
