/**
 * Raw context counter footer
 *
 * Replaces the built-in footer with a version where the context counter
 * shows raw token counts (e.g. "25k/200k (auto)") instead of a
 * percentage (e.g. "12.5%/200k (auto)"). Rounding follows the built-in
 * token formatting, so 24,600 tokens renders as "25k".
 *
 * Everything else mirrors the built-in footer: pwd + git branch + session
 * name line, token stats (cache/cost omitted - local-only), color
 * thresholds (>90% red, >70% yellow), model name + thinking level on the
 * right, and the extension status line.
 *
 * To revert: remove this file and /reload (or restart pi).
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Helpers mirrored from the built-in footer (not exported by the package) ---

function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

// --- Auto-compact indicator ---------------------------------------------------
// Mirrors pi's resolution of `compaction.enabled`: project settings override
// global settings, default true. Files are re-read only when their mtime changes.

let settingsCache: { global: number | undefined; project: number | undefined; value: boolean } | undefined;

function isAutoCompactEnabled(cwd: string): boolean {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json");

	const readOne = (path: string): { mtimeMs: number; enabled?: boolean } | undefined => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
		let enabled: boolean | undefined;
		try {
			const json = JSON.parse(readFileSync(path, "utf8")) as { compaction?: { enabled?: boolean } };
			enabled = json.compaction?.enabled;
		} catch {
			// Unreadable/invalid file: pi itself falls back to defaults
		}
		return { mtimeMs, enabled };
	};

	const global = readOne(globalPath);
	const project = readOne(projectPath);
	if (settingsCache && settingsCache.global === global?.mtimeMs && settingsCache.project === project?.mtimeMs) {
		return settingsCache.value;
	}
	const value = project?.enabled ?? global?.enabled ?? true;
	settingsCache = { global: global?.mtimeMs, project: project?.mtimeMs, value };
	return value;
}

// --- Footer -------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Footer only exists in the interactive TUI
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			// Re-render on git branch changes (the built-in provider does this for the stock footer)
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					// Cumulative input/output tokens from ALL session entries
					let totalInput = 0;
					let totalOutput = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
						}
					}

					// Context usage from session (handles compaction correctly).
					// After compaction, tokens are unknown until the next LLM response.
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;

					// Replace home directory with ~
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

					// Add git branch if available
					const branch = footerData.getGitBranch();
					if (branch) {
						pwd = `${pwd} (${branch})`;
					}

					// Add session name if set
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}

					// Build stats line (cache/cost stats omitted - local-only)
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);

					// Colorize context usage based on the percentage.
					// THE DIFFERENCE: display raw used tokens instead of the percentage.
					const autoIndicator = isAutoCompactEnabled(ctx.cwd) ? " (auto)" : "";
					const contextUsed = contextUsage?.tokens; // number | null | undefined
					const contextDisplay =
						contextUsed == null
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${formatTokens(contextUsed)}/${formatTokens(contextWindow)}${autoIndicator}`;
					if (contextPercentValue > 90) {
						statsParts.push(theme.fg("error", contextDisplay));
					} else if (contextPercentValue > 70) {
						statsParts.push(theme.fg("warning", contextDisplay));
					} else {
						statsParts.push(contextDisplay);
					}
					if (process.env.PI_EXPERIMENTAL === "1") {
						statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
					}

					let statsLeft = statsParts.join(" ");

					// If statsLeft is too wide, truncate it
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const minPadding = 2;

					// Add model name on the right side, plus thinking level if model supports reasoning
					let rightSideWithoutProvider = ctx.model?.id || "no-model";
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel() || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${rightSideWithoutProvider} • thinking off`
								: `${rightSideWithoutProvider} • ${thinkingLevel}`;
					}

					// Prepend the provider in parentheses if there are multiple providers and there's enough room
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
							// Too wide, fall back
							rightSide = rightSideWithoutProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						// Both fit - add padding to right-align model
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						// Need to truncate right side
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							// Not enough space for right side at all
							statsLine = statsLeft;
						}
					}

					// Apply dim to each part separately. statsLeft may contain color codes (for context)
					// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
					// before and after the colored section independently.
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
					const dimRemainder = theme.fg("dim", remainder);

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// Add extension statuses on a single line, sorted by key alphabetically
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
