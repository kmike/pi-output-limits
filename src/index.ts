/**
 * pi-output-limits — global, configurable caps on tool output size.
 *
 * Pi's built-in tools truncate their own output at 2000 lines / 50KB, and those
 * limits are hardcoded. This extension sits on the `tool_result` event (which can
 * modify results) and re-truncates every tool's output — built-in or extension —
 * down to your own lower limits, before the result reaches the model's context.
 *
 * Design notes:
 * - bash (and anything in `tailTools`) keeps the END of the output, like pi's
 *   built-in bash truncation. Everything else keeps the beginning.
 * - When this extension truncates output that the built-in tool did not, the
 *   full text is saved to a temp file and the footer points at it, so the model
 *   can always recover the rest. (Pi itself only writes bash temp files when
 *   its own 50KB limit trips.)
 * - For bash results, `details.truncation` / `details.fullOutputPath` are patched
 *   so the TUI shows the real numbers and strips the footer from display, exactly
 *   as it does for native truncation.
 * - A one-line note is appended to the system prompt via `before_agent_start` so
 *   the model knows the real caps (tool descriptions still quote pi's built-in
 *   limits, which are higher).
 *
 * Config (global `~/.pi/agent/settings.json`, or project `.pi/settings.json`
 * when the project is trusted; project values win):
 *
 *   "outputLimits": {
 *     "maxLines": 500,
 *     "maxBytes": 16384,
 *     "tools": { "bash": { "maxLines": 300, "maxBytes": 8192 } },
 *     "tailTools": ["bash"]
 *   }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Defaults intentionally match pi's built-in truncation limits (imported from
// pi-coding-agent, currently 2000 lines / 50KB), so installing the extension
// changes nothing until the user configures different values.
const DEFAULT_TAIL_TOOLS = ["bash"];

interface Limits {
	maxLines: number;
	maxBytes: number;
}

interface OutputLimitsSettings {
	maxLines?: unknown;
	maxBytes?: unknown;
	tools?: unknown;
	tailTools?: unknown;
}

interface RuntimeConfig {
	global: Limits;
	tools: Map<string, Partial<Limits>>;
	tailTools: Set<string>;
}

interface TruncationDetails {
	truncation?: {
		truncated: boolean;
		truncatedBy?: string | null;
		outputLines?: number;
		totalLines?: number;
		totalBytes?: number;
	};
	fullOutputPath?: string;
}

const fallbackConfig: RuntimeConfig = {
	global: { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES },
	tools: new Map(),
	tailTools: new Set(DEFAULT_TAIL_TOOLS),
};

/** True when the config matches pi's built-in behavior exactly (no-op mode). */
function isDefaultConfig(config: RuntimeConfig): boolean {
	return (
		config.global.maxLines === DEFAULT_MAX_LINES &&
		config.global.maxBytes === DEFAULT_MAX_BYTES &&
		config.tools.size === 0 &&
		config.tailTools.size === DEFAULT_TAIL_TOOLS.length &&
		DEFAULT_TAIL_TOOLS.every((t) => config.tailTools.has(t))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(
	value: unknown,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value as number;
}

function readSettingsFile(path: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error(`Pi settings at ${path} must contain a JSON object`);
	}
	return parsed;
}

function getOutputLimitsSettings(
	settings: Record<string, unknown>,
	path: string,
): OutputLimitsSettings {
	const section = settings.outputLimits;
	if (section === undefined) return {};
	if (!isRecord(section)) {
		throw new Error(`outputLimits in ${path} must be a JSON object`);
	}
	const supported = new Set(["maxLines", "maxBytes", "tools", "tailTools"]);
	for (const key of Object.keys(section)) {
		if (!supported.has(key)) {
			throw new Error(
				`Unsupported outputLimits setting "${key}" in ${path}; supported settings are ${[...supported].join(", ")}`,
			);
		}
	}
	return section;
}

function parseLimits(
	value: unknown,
	fallback: Limits,
	name: string,
): Limits {
	if (value === undefined) return fallback;
	if (!isRecord(value)) throw new Error(`${name} must be a JSON object`);
	return {
		maxLines: positiveInteger(value.maxLines, fallback.maxLines, `${name}.maxLines`),
		maxBytes: positiveInteger(value.maxBytes, fallback.maxBytes, `${name}.maxBytes`),
	};
}

function parseToolOverrides(
	value: unknown,
	name: string,
): Map<string, Partial<Limits>> {
	const result = new Map<string, Partial<Limits>>();
	if (value === undefined) return result;
	if (!isRecord(value)) throw new Error(`${name} must be a JSON object`);
	for (const [tool, limits] of Object.entries(value)) {
		if (!isRecord(limits)) {
			throw new Error(`${name}.${tool} must be a JSON object`);
		}
		result.set(tool, {
			maxLines:
				limits.maxLines === undefined
					? undefined
					: positiveInteger(limits.maxLines, 0, `${name}.${tool}.maxLines`),
			maxBytes:
				limits.maxBytes === undefined
					? undefined
					: positiveInteger(limits.maxBytes, 0, `${name}.${tool}.maxBytes`),
		});
	}
	return result;
}

function parseTailTools(value: unknown, name: string): Set<string> {
	if (value === undefined) return new Set();
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new Error(`${name} must be an array of tool names`);
	}
	return new Set(value as string[]);
}

function loadRuntimeConfig(cwd: string, projectTrusted: boolean): RuntimeConfig {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json");

	const globalSettings = getOutputLimitsSettings(
		readSettingsFile(globalPath),
		globalPath,
	);
	const projectSettings = projectTrusted
		? getOutputLimitsSettings(readSettingsFile(projectPath), projectPath)
		: {};

	const base: Limits = {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	};
	const afterGlobal = parseLimits(
		{ maxLines: globalSettings.maxLines, maxBytes: globalSettings.maxBytes },
		base,
		"outputLimits",
	);
	// Drop undefined keys so project settings don't erase global values.
	const projectLimits: Record<string, unknown> = {};
	if (projectSettings.maxLines !== undefined)
		projectLimits.maxLines = projectSettings.maxLines;
	if (projectSettings.maxBytes !== undefined)
		projectLimits.maxBytes = projectSettings.maxBytes;
	const global_ = parseLimits(projectLimits, afterGlobal, "outputLimits");

	const tools = parseToolOverrides(globalSettings.tools, "outputLimits.tools");
	for (const [tool, limits] of parseToolOverrides(
		projectSettings.tools,
		"outputLimits.tools",
	)) {
		tools.set(tool, { ...tools.get(tool), ...limits });
	}

	const tailTools = new Set(DEFAULT_TAIL_TOOLS);
	for (const t of parseTailTools(globalSettings.tailTools, "outputLimits.tailTools"))
		tailTools.add(t);
	for (const t of parseTailTools(projectSettings.tailTools, "outputLimits.tailTools"))
		tailTools.add(t);

	return { global: global_, tools, tailTools };
}

/**
 * Remove a built-in truncation footer ("[Showing lines X-Y of Z. Full output: ...]")
 * from text so it can be replaced with one that reflects the real numbers.
 * Only called when the tool reported truncation in its details, so a trailing
 * bracketed paragraph is almost certainly that footer.
 */
function stripBuiltinFooter(text: string, fullOutputPath?: string): string {
	if (!text.endsWith("]")) return text;
	const start = text.lastIndexOf("\n\n[");
	if (start === -1) return text;
	const paragraph = text.slice(start);
	if (fullOutputPath && paragraph.includes(fullOutputPath)) {
		return text.slice(0, start);
	}
	if (/^\n\n\[(Showing|Output truncated|Truncated)/.test(paragraph)) {
		return text.slice(0, start);
	}
	return text;
}

function saveFullOutput(toolName: string, text: string): string | undefined {
	try {
		const id = randomBytes(4).toString("hex");
		const path = join(tmpdir(), `pi-output-limits-${toolName}-${id}.log`);
		writeFileSync(path, text);
		return path;
	} catch {
		return undefined;
	}
}

export default function piOutputLimits(pi: ExtensionAPI): void {
	let config: RuntimeConfig = fallbackConfig;

	pi.on("session_start", (_event, ctx) => {
		config = loadRuntimeConfig(ctx.cwd, ctx.isProjectTrusted());
	});

	// Tool descriptions still quote pi's built-in 2000-line/50KB limits; tell the
	// model the real caps once, in the system prompt, instead of re-registering
	// every tool just to patch its description. With default settings the
	// extension is a no-op, so don't spend system-prompt tokens on it.
	pi.on("before_agent_start", (event) => {
		if (isDefaultConfig(config)) return;

		const limits = config.global;
		// Limits above pi's built-ins can't raise the caps of built-in tools —
		// those discard output beyond their own limits before we see it. Say so,
		// otherwise the note would promise caps the built-in tools don't honor.
		const exceedsBuiltin =
			limits.maxLines > DEFAULT_MAX_LINES ||
			limits.maxBytes > DEFAULT_MAX_BYTES;
		const caveat = exceedsBuiltin
			? ` Limits above pi's built-in ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)} only affect extension-registered tools; built-in tools discard output beyond their own caps before this extension runs.`
			: "";
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nNote: tool outputs are additionally capped at ~${limits.maxLines} lines / ${formatSize(limits.maxBytes)} per result by the pi-output-limits extension (individual tools may have stricter caps; bash keeps the tail of its output). When a result is truncated, its footer shows the real counts and a temp-file path to the full output.${caveat}`,
		};
	});

	pi.on("tool_result", (event) => {
		if (!Array.isArray(event.content)) return;

		const toolName = event.toolName;
		const overrides = config.tools.get(toolName);
		const limits: Limits = {
			maxLines: overrides?.maxLines ?? config.global.maxLines,
			maxBytes: overrides?.maxBytes ?? config.global.maxBytes,
		};
		const tail = config.tailTools.has(toolName);
		const isBash = toolName === "bash";

		const details = (event.details ?? {}) as TruncationDetails;
		const builtinTruncated = details.truncation?.truncated === true;

		let changed = false;
		let patchedDetails: TruncationDetails | undefined;

		const content = event.content.map((block) => {
			if (block.type !== "text") return block;

			// If the built-in tool already truncated, drop its footer so ours
			// (with the real numbers) is the only one the model sees.
			let text = block.text as string;
			if (builtinTruncated) {
				text = stripBuiltinFooter(text, details.fullOutputPath);
			}

			const t = tail
				? truncateTail(text, limits)
				: truncateHead(text, limits);

			if (!t.truncated) {
				// Within our limits: pass the block through untouched. In
				// particular, when the built-in tool already truncated (because our
				// limits are the same or higher), its own footer is still accurate —
				// stripping it here would hide the truncation from the model
				// entirely.
				return block;
			}

			changed = true;

			// Totals describe the original full output: if the built-in tool cut
			// first, its totals are the true ones.
			const totalLines = details.truncation?.totalLines ?? t.totalLines;
			const totalBytes = details.truncation?.totalBytes ?? t.totalBytes;

			// The built-in bash temp file (if any) holds the complete output —
			// reuse it. Otherwise save what we received before cutting.
			const fullOutputPath =
				details.fullOutputPath ?? saveFullOutput(toolName, text);

			const where = fullOutputPath
				? ` Full output: ${fullOutputPath}`
				: " Full output unavailable (temp file write failed).";
			const footer =
				`\n\n[Showing ${t.outputLines} of ${totalLines} lines ` +
				`(${formatSize(t.outputBytes)} of ${formatSize(totalBytes)}, ` +
				`limit ${limits.maxLines} lines/${formatSize(limits.maxBytes)}).` +
				`${where}]`;

			if (isBash) {
				// Keep the TUI's native truncation warning accurate: it renders
				// from details.truncation and strips a trailing footer that
				// mentions fullOutputPath — ours is formatted to match.
				patchedDetails = {
					...details,
					truncation: {
						truncated: true,
						truncatedBy: t.truncatedBy ?? "bytes",
						outputLines: t.outputLines,
						totalLines,
					},
					fullOutputPath,
				};
			}

			return { ...block, text: t.content + footer };
		});

		if (!changed) return;
		return {
			content,
			...(patchedDetails ? { details: patchedDetails } : {}),
		};
	});
}
