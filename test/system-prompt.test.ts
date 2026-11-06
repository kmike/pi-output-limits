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
		expect(result?.systemPrompt).toContain("bash keeps the tail");
	});

	it("frames truncation as recoverable, not as a shrinking allowance", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 100, maxBytes: 4096 } },
		});
		const note = (fireBeforeAgentStart(h)?.systemPrompt ?? "").slice(
			"BASE PROMPT".length,
		);
		// The fact the model needs at the moment of loss: the footer says where
		// to read what the cut removed.
		expect(note).toContain("where to read what it left out");
		expect(note).toContain("temp file");
		expect(note).toContain("next offset");
		// Not a promise of total recoverability: pi discards beyond its own caps
		// first, so the saved file can be a slice of a slice.
		expect(note.toLowerCase()).not.toContain("nothing is lost");
		expect(note).toContain("on top of any cap the tool applies itself");
		// And nothing that reads as a session-level allowance: a per-result cap is
		// not a budget, and even denying a budget names one.
		for (const word of [
			"budget",
			"allowance",
			"remaining",
			"exhaust",
			"context window",
			"conversation",
		]) {
			expect(note.toLowerCase()).not.toContain(word);
		}
	});

	it("adds a note when only a per-tool override is configured", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { tools: { bash: { maxLines: 10 } } } },
		});
		expect(fireBeforeAgentStart(h)?.systemPrompt).toContain("pi-output-limits");
	});

	it("adds no note when limits are only raised above pi's (the user is warned instead)", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 5000, maxBytes: 102400 } },
		});
		expect(fireBeforeAgentStart(h)).toBeUndefined();
	});

	it("never promises more than pi's built-in caps when mixed with lower overrides", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: {
				outputLimits: {
					maxLines: 5000,
					tools: { bash: { maxLines: 300 } },
				},
			},
		});
		const prompt = fireBeforeAgentStart(h)?.systemPrompt ?? "";
		// Note exists because bash is stricter, but the global claim is clamped
		// to what built-in tools can actually deliver.
		expect(prompt).toContain("~2000 lines / 50.0KB");
		expect(prompt).not.toContain("5000");
	});
});
