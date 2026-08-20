import { describe, expect, it } from "vitest";
import {
	createHarness,
	fireToolResult,
	makeLines,
	startSession,
	textBlock,
} from "./harness";

/** Extract the text of the first content block from a tool_result result. */
function resultText(result: any): string {
	return result.content[0].text;
}

function keptLines(text: string): string[] {
	return text.split("\n\n[")[0].split("\n");
}

describe("config loading", () => {
	it("defaults to pi's built-in limits (2000 lines / 50KB) with no settings", () => {
		const h = createHarness();
		startSession(h);
		// Under pi's caps: untouched.
		expect(
			fireToolResult(h, { content: [textBlock(makeLines(1999))] }),
		).toBeUndefined();
		// Over pi's caps (only possible for extension tools): capped like pi would.
		const result = fireToolResult(h, { content: [textBlock(makeLines(2500))] });
		expect(resultText(result)).toContain(
			"[Showing 2000 of 2500 lines",
		);
		expect(resultText(result)).toContain("limit 2000 lines/50.0KB");
	});

	it("applies global settings", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		const result = fireToolResult(h, { content: [textBlock(makeLines(200))] });
		expect(keptLines(resultText(result))).toHaveLength(100);
		expect(resultText(result)).toContain("[Showing 100 of 200 lines");
	});

	it("project settings win over global when the project is trusted", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 500 } },
			projectSettings: { outputLimits: { maxLines: 100 } },
			trusted: true,
		});
		const result = fireToolResult(h, { content: [textBlock(makeLines(200))] });
		expect(keptLines(resultText(result))).toHaveLength(100);
	});

	it("ignores project settings when the project is not trusted", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 500 } },
			projectSettings: { outputLimits: { maxLines: 100 } },
			trusted: false,
		});
		const result = fireToolResult(h, { content: [textBlock(makeLines(600))] });
		expect(keptLines(resultText(result))).toHaveLength(500);
	});

	it("partial project overrides do not erase other global values", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 300, maxBytes: 4096 } },
			projectSettings: { outputLimits: { maxLines: 100 } },
			trusted: true,
		});
		// 100 lines of ~100 chars each ≈ 10KB — the global 4KB byte cap must
		// still apply even though the project only overrode maxLines.
		const longLines = Array.from({ length: 100 }, (_, i) => `row ${i} ${"x".repeat(95)}`).join("\n");
		const result = fireToolResult(h, { content: [textBlock(longLines)] });
		const kept = keptLines(resultText(result));
		expect(kept.length).toBeLessThan(100);
		expect(resultText(result)).toContain("limit 100 lines/4.0KB");
	});

	it("applies per-tool overrides", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: {
				outputLimits: { maxLines: 500, tools: { bash: { maxLines: 10 } } },
			},
		});
		const bash = fireToolResult(h, {
			toolName: "bash",
			content: [textBlock(makeLines(50))],
		});
		expect(keptLines(resultText(bash))).toHaveLength(10);

		const read = fireToolResult(h, { content: [textBlock(makeLines(600))] });
		expect(keptLines(resultText(read))).toHaveLength(500);
	});

	it("merges per-tool overrides across global and project settings", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { tools: { bash: { maxLines: 10 } } } },
			projectSettings: { outputLimits: { tools: { bash: { maxLines: 20 } } } },
			trusted: true,
		});
		const bash = fireToolResult(h, {
			toolName: "bash",
			content: [textBlock(makeLines(50))],
		});
		expect(keptLines(resultText(bash))).toHaveLength(20);
	});

	it("treats tailTools as a union on top of the default (bash)", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: {
				outputLimits: { maxLines: 10, tailTools: ["mytool"] },
			},
		});
		// tail tool keeps the END of the output
		const tail = fireToolResult(h, {
			toolName: "mytool",
			content: [textBlock(makeLines(50))],
		});
		const tailKept = keptLines(resultText(tail));
		expect(tailKept[0]).toBe("line 41");
		expect(tailKept.at(-1)).toBe("line 50");
		// bash stays a tail tool
		const bash = fireToolResult(h, {
			toolName: "bash",
			content: [textBlock(makeLines(50))],
		});
		expect(keptLines(resultText(bash))[0]).toBe("line 41");
		// everything else keeps the head
		const read = fireToolResult(h, { content: [textBlock(makeLines(50))] });
		expect(keptLines(resultText(read))[0]).toBe("line 1");
	});

	it("reloads config on session_start", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		expect(
			keptLines(
				resultText(fireToolResult(h, { content: [textBlock(makeLines(200))] })),
			),
		).toHaveLength(100);

		startSession(h, { globalSettings: { outputLimits: { maxLines: 20 } } });
		expect(
			keptLines(
				resultText(fireToolResult(h, { content: [textBlock(makeLines(200))] })),
			),
		).toHaveLength(20);
	});
});

describe("session warnings for ineffective limits", () => {
	it("warns when global limits exceed pi's built-in caps", () => {
		const h = createHarness();
		const notifications = startSession(h, {
			globalSettings: { outputLimits: { maxLines: 5000, maxBytes: 102400 } },
		});
		expect(notifications).toHaveLength(1);
		expect(notifications[0].type).toBe("warning");
		expect(notifications[0].message).toContain("maxLines=5000");
		expect(notifications[0].message).toContain("maxBytes=102400");
		expect(notifications[0].message).toContain("extension-registered tools");
	});

	it("warns about above-cap overrides for built-in tools", () => {
		const h = createHarness();
		const notifications = startSession(h, {
			globalSettings: {
				outputLimits: { tools: { bash: { maxLines: 9000 } } },
			},
		});
		expect(notifications).toHaveLength(1);
		expect(notifications[0].message).toContain("tools.bash.maxLines=9000");
	});

	it("does not warn about above-cap overrides for third-party tools", () => {
		const h = createHarness();
		const notifications = startSession(h, {
			globalSettings: {
				outputLimits: { tools: { webfetch: { maxLines: 9000 } } },
			},
		});
		expect(notifications).toHaveLength(0);
	});

	it("does not warn at or below pi's caps", () => {
		const h = createHarness();
		expect(
			startSession(h, {
				globalSettings: {
					outputLimits: { maxLines: 100, tools: { bash: { maxLines: 2000 } } },
				},
			}),
		).toHaveLength(0);
		expect(startSession(h)).toHaveLength(0);
	});
});

describe("config validation", () => {
	function expectConfigError(settings: Record<string, unknown>, match: RegExp) {
		const h = createHarness();
		expect(() => startSession(h, { globalSettings: settings })).toThrow(match);
	}

	it("rejects unknown outputLimits keys", () => {
		expectConfigError(
			{ outputLimits: { maxLine: 10 } },
			/Unsupported outputLimits setting "maxLine"/,
		);
	});

	it("rejects non-positive maxLines", () => {
		expectConfigError({ outputLimits: { maxLines: 0 } }, /must be a positive integer/);
	});

	it("rejects non-integer maxBytes", () => {
		expectConfigError(
			{ outputLimits: { maxBytes: 1.5 } },
			/must be a positive integer/,
		);
	});

	it("rejects a non-object outputLimits section", () => {
		expectConfigError({ outputLimits: "nope" }, /must be a JSON object/);
	});

	it("rejects non-object per-tool overrides", () => {
		expectConfigError(
			{ outputLimits: { tools: { bash: 10 } } },
			/outputLimits\.tools\.bash must be a JSON object/,
		);
	});

	it("rejects tailTools that are not an array of strings", () => {
		expectConfigError(
			{ outputLimits: { tailTools: "bash" } },
			/must be an array of tool names/,
		);
		expectConfigError(
			{ outputLimits: { tailTools: ["bash", 42] } },
			/must be an array of tool names/,
		);
	});
});
