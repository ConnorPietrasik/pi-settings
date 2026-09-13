/**
 * setup-sync.ts — seeds the personal pi config files bundled with this
 * package into the user's agent dir (~/.pi/agent by default).
 *
 * This package ships a personal setup under setup/:
 *   - models.json:  custom provider definitions (local llama-cpp server)
 *   - settings.json: compaction defaults
 *
 * On every session_start, whatever is missing is merged into the user's
 * files. Merge rules (never clobber user data):
 *   - models.json:  each bundled provider is added only if that provider is
 *                   not already defined; existing provider entries are
 *                   never modified.
 *   - settings.json: only missing leaf keys are filled in (currently
 *                   compaction.*); existing values are never overwritten.
 *
 * Local LLM server address
 * ------------------------
 * The bundled llama-cpp provider's baseUrl is machine-specific. When the
 * provider is being seeded for the first time on a machine:
 *   1. PI_LLM_BASE_URL env var wins (non-interactive installs, print mode,
 *      CI)
 *   2. otherwise, in the interactive TUI, the user is prompted once for the
 *      address (Esc falls back to the bundled default)
 *   3. otherwise the bundled default is used
 * After seeding, the address is only changed via the /llm-setup command
 * (set a new address, or remove the provider).
 *
 * When everything is already in place this is a silent no-op (a few file
 * reads). New values take effect on the next pi start.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SETUP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "setup");

const LLM_PROVIDER = "llama-cpp";
const DEFAULT_LLM_BASE_URL = "http://localhost:8080/v1";

type Json = Record<string, unknown>;

interface SyncResult {
	changed: boolean;
	/** Human-readable list of what was added/changed. */
	detail: string;
}

function readJson(path: string): Json | undefined {
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Json) : undefined;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, data: Json): void {
	writeFileSync(path, JSON.stringify(data, null, "\t") + "\n");
}

function isPlainObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeUrl(value: string): boolean {
	return /^https?:\/\/\S+$/.test(value);
}

function bundledProviders(): Json | undefined {
	const p = readJson(join(SETUP_DIR, "models.json"))?.providers;
	return isPlainObject(p) ? p : undefined;
}

function userModels(agentDir: string): Json {
	return readJson(join(agentDir, "models.json")) ?? {};
}

// ---------------------------------------------------------------------------
// Pure sync logic (operates on the given agent dir; no UI)
// ---------------------------------------------------------------------------

/**
 * Whether the bundled llama-cpp provider would still be seeded (i.e. it is
 * bundled but not yet defined in the user's models.json).
 */
export function llmProviderMissing(agentDir: string): boolean {
	const bundled = bundledProviders();
	if (!bundled || !(LLM_PROVIDER in bundled)) return false;
	const userProviders = userModels(agentDir).providers;
	if (!isPlainObject(userProviders)) return true;
	return !(LLM_PROVIDER in userProviders);
}

/**
 * Add bundled providers to <agentDir>/models.json that are not defined yet.
 * `llmBaseUrl`, when given, overrides the seeded llama-cpp provider's
 * baseUrl.
 */
export function syncModels(agentDir: string, llmBaseUrl?: string): SyncResult {
	const bundled = bundledProviders();
	if (!bundled) return { changed: false, detail: "" };

	const modelsPath = join(agentDir, "models.json");
	const current = userModels(agentDir);
	if (!isPlainObject(current.providers)) current.providers = {};

	const added: string[] = [];
	for (const [name, def] of Object.entries(bundled)) {
		if (name in current.providers) continue;
		if (name === LLM_PROVIDER && llmBaseUrl && isPlainObject(def)) {
			current.providers[name] = { ...def, baseUrl: llmBaseUrl };
		} else {
			current.providers[name] = def;
		}
		added.push(name);
	}
	if (added.length === 0) return { changed: false, detail: "" };

	writeJson(modelsPath, current);
	return { changed: true, detail: added.join(", ") };
}

/**
 * Fill in missing leaf keys from <setup>/settings.json into
 * <agentDir>/settings.json, recursing into nested objects.
 */
export function syncSettings(agentDir: string): SyncResult {
	const bundled = readJson(join(SETUP_DIR, "settings.json"));
	if (!bundled) return { changed: false, detail: "" };

	const settingsPath = join(agentDir, "settings.json");
	const current = readJson(settingsPath) ?? {};

	const fillMissing = (target: Json, source: Json, prefix: string): string[] => {
		const added: string[] = [];
		for (const [key, value] of Object.entries(source)) {
			const name = prefix ? `${prefix}.${key}` : key;
			if (target[key] === undefined) {
				target[key] = value;
				added.push(name);
			} else if (isPlainObject(target[key]) && isPlainObject(value)) {
				added.push(...fillMissing(target[key], value, name));
			}
		}
		return added;
	};

	const added = fillMissing(current, bundled, "");
	if (added.length === 0) return { changed: false, detail: "" };

	writeJson(settingsPath, current);
	return { changed: true, detail: added.join(", ") };
}

// ---------------------------------------------------------------------------
// /llm-setup command helpers
// ---------------------------------------------------------------------------

/**
 * Set the llama-cpp provider's baseUrl, creating the provider (from the
 * bundled definition) if it doesn't exist yet.
 */
export function setLlmBaseUrl(agentDir: string, baseUrl: string): void {
	const modelsPath = join(agentDir, "models.json");
	const current = userModels(agentDir);
	if (!isPlainObject(current.providers)) current.providers = {};

	const existing = current.providers[LLM_PROVIDER];
	const bundledDef = bundledProviders()?.[LLM_PROVIDER];
	const def: Json = isPlainObject(existing)
		? existing
		: isPlainObject(bundledDef)
			? { ...bundledDef }
			: { baseUrl, api: "openai-completions", apiKey: "none", models: [] };
	def.baseUrl = baseUrl;
	current.providers[LLM_PROVIDER] = def;

	writeJson(modelsPath, current);
}

/** Remove the llama-cpp provider. Returns true if it existed and was removed. */
export function removeLlmProvider(agentDir: string): boolean {
	const modelsPath = join(agentDir, "models.json");
	const current = userModels(agentDir);
	const providers = current.providers;
	if (!isPlainObject(providers) || !(LLM_PROVIDER in providers)) return false;
	delete providers[LLM_PROVIDER];
	writeJson(modelsPath, current);
	return true;
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const notes: string[] = [];
		try {
			const agentDir = getAgentDir();

			// Resolve the LLM server address for a first-time seed only.
			// Precedence: env var > TUI prompt > bundled default.
			let llmBaseUrl: string | undefined;
			if (llmProviderMissing(agentDir)) {
				if (process.env.PI_LLM_BASE_URL) {
					llmBaseUrl = process.env.PI_LLM_BASE_URL;
				} else if (ctx.hasUI) {
					const answer = await ctx.ui.input(
						"Local LLM server address (Esc to keep default):",
						DEFAULT_LLM_BASE_URL,
					);
					if (answer && looksLikeUrl(answer.trim())) {
						llmBaseUrl = answer.trim();
					}
				}
			}

			const models = syncModels(agentDir, llmBaseUrl);
			if (models.changed) notes.push(`model provider(s): ${models.detail}`);
			const settings = syncSettings(agentDir);
			if (settings.changed) notes.push(`settings: ${settings.detail}`);
		} catch (err: any) {
			if (ctx.hasUI) ctx.ui.notify(`setup-sync failed: ${err?.message ?? err}`, "error");
			return;
		}
		if (notes.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`personal setup seeded into ${getAgentDir()} (${notes.join("; ")}). Restart pi to apply it.`,
				"info",
			);
		}
	});

	pi.registerCommand("llm-setup", {
		description: "Set or remove the local llama-cpp LLM server address",
		handler: async (_args, ctx) => {
			const agentDir = getAgentDir();
			const choice = await ctx.ui.select("Local LLM server (llama-cpp)", [
				"Set a new address",
				"Remove the provider",
				"Cancel",
			]);
			if (choice === "Set a new address") {
				const answer = await ctx.ui.input("Server address:", DEFAULT_LLM_BASE_URL);
				if (answer === undefined) return; // cancelled
				if (!looksLikeUrl(answer.trim())) {
					ctx.ui.notify(`Not a valid URL (expected http:// or https://): ${answer}`, "error");
					return;
				}
				setLlmBaseUrl(agentDir, answer.trim());
				ctx.ui.notify(`llama-cpp baseUrl set to ${answer.trim()}. Restart pi to apply.`, "info");
			} else if (choice === "Remove the provider") {
				const ok = await ctx.ui.confirm(
					"Remove llama-cpp provider?",
					"The provider entry will be deleted from models.json.",
				);
				if (!ok) return;
				const removed = removeLlmProvider(agentDir);
				ctx.ui.notify(
					removed
						? "llama-cpp provider removed. Restart pi to apply."
						: "llama-cpp provider not found — nothing to do.",
					removed ? "info" : "warning",
				);
			}
		},
	});
}
