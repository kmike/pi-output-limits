import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piOutputLimits from "../src/index";

type Handler = (event: any, ctx: any) => unknown;

/**
 * Minimal stand-in for pi's extension runtime: captures the handlers the
 * extension registers so tests can fire events synchronously.
 */
export function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	piOutputLimits(pi as unknown as ExtensionAPI);

	return {
		/** Fire an event at all registered handlers; returns their results. */
		fire(event: string, data?: unknown, ctx?: unknown): unknown[] {
			return (handlers.get(event) ?? []).map((h) => h(data, ctx));
		},
	};
}

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

export interface SessionOptions {
	/** Written to <agentDir>/settings.json when provided. */
	globalSettings?: Record<string, unknown>;
	/** Written to <cwd>/.pi/settings.json when provided. */
	projectSettings?: Record<string, unknown>;
	trusted?: boolean;
}

/**
 * Point the agent dir at a temp dir, optionally write global/project settings,
 * and fire session_start so the extension (re)loads its config.
 */
export function startSession(
	harness: ReturnType<typeof createHarness>,
	opts: SessionOptions = {},
): void {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ol-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "pi-ol-proj-"));
	try {
		if (opts.globalSettings) {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify(opts.globalSettings),
			);
		}
		if (opts.projectSettings) {
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify(opts.projectSettings),
			);
		}
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			harness.fire(
				"session_start",
				{ type: "session_start", reason: "startup" },
				{ cwd: projectDir, isProjectTrusted: () => opts.trusted ?? false },
			);
		} finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}

export function makeLines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

export function textBlock(text: string) {
	return { type: "text", text };
}

export function toolResultEvent(overrides: Record<string, unknown> = {}) {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "read",
		input: {},
		isError: false,
		content: [textBlock(makeLines(10))],
		details: undefined,
		...overrides,
	};
}

/** Fire a tool_result event and return the extension's (single) result. */
export function fireToolResult(
	harness: ReturnType<typeof createHarness>,
	overrides: Record<string, unknown> = {},
): any {
	const results = harness.fire("tool_result", toolResultEvent(overrides));
	return results[0];
}
