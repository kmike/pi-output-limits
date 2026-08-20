import { describe, expect, it } from "vitest";
import { createHarness, startSession } from "./harness";

function fireBeforeAgentStart(
	h: ReturnType<typeof createHarness>,
): { systemPrompt: string } | undefined {
	const results = h.fire("before_agent_start", {
		type: "before_agent_start",
		prompt: "hi",
		systemPrompt: "BASE PROMPT",
	});
	return results[0] as { systemPrompt: string } | undefined;
}

describe("before_agent_start system prompt note", () => {
	it("adds no note with default settings (extension is a no-op)", () => {
		const h = createHarness();
		startSession(h); // no settings files anywhere
		expect(fireBeforeAgentStart(h)).toBeUndefined();
	});

	it("adds no note when never initialized (fallback config = defaults)", () => {
		const h = createHarness(); // no session_start fired
		expect(fireBeforeAgentStart(h)).toBeUndefined();
	});

	it("adds no note when settings explicitly match pi's defaults", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 2000, maxBytes: 51200 } },
		});
		expect(fireBeforeAgentStart(h)).toBeUndefined();
	});

	it("states the real caps when limits are lowered", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 100, maxBytes: 4096 } },
		});
		const result = fireBeforeAgentStart(h);
		expect(result?.systemPrompt).toContain("BASE PROMPT");
		expect(result?.systemPrompt).toContain("~100 lines / 4.0KB");
		expect(result?.systemPrompt).toContain("pi-output-limits");
	});

	it("adds a note when only a per-tool override is configured", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { tools: { bash: { maxLines: 10 } } } },
		});
		expect(fireBeforeAgentStart(h)?.systemPrompt).toContain("pi-output-limits");
	});

	it("warns that higher limits cannot raise built-in tool caps", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 5000, maxBytes: 102400 } },
		});
		const prompt = fireBeforeAgentStart(h)?.systemPrompt ?? "";
		expect(prompt).toContain("~5000 lines / 100.0KB");
		expect(prompt).toContain(
			"built-in tools discard output beyond their own caps",
		);
	});

	it("omits the built-in-caps caveat when limits stay at or below pi's", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 100 } },
		});
		const prompt = fireBeforeAgentStart(h)?.systemPrompt ?? "";
		expect(prompt).not.toContain(
			"built-in tools discard output beyond their own caps",
		);
	});
});
