import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createHarness,
	fireToolResult,
	makeLines,
	startSession,
	textBlock,
} from "./harness";

/** Extract the temp-file path from a truncation footer. */
function footerPath(text: string): string {
	const match = text.match(/Full output: ([^\]]+)\]/);
	expect(match, `footer should contain a full-output path: ${text}`).not.toBeNull();
	return match![1];
}

function firstText(result: any): string {
	return result.content[0].text;
}

describe("tool_result truncation", () => {
	it("passes results under the limits through untouched", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 500 } } });
		const event = {
			toolName: "read",
			content: [textBlock(makeLines(100))],
		};
		expect(fireToolResult(h, event)).toBeUndefined();
	});

	it("keeps the head for regular tools and appends a footer with real counts", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 500 } } });
		const original = makeLines(600);
		const result = fireToolResult(h, { content: [textBlock(original)] });

		const text = firstText(result);
		expect(text).toContain("line 500");
		expect(text).not.toContain("line 501");
		expect(text).toMatch(/\[Showing 500 of 600 lines \(/);

		// Full output is recoverable from the temp file named in the footer.
		const path = footerPath(text);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(original);

		// details are only patched for bash.
		expect(result.details).toBeUndefined();
	});

	it("keeps the tail for bash and patches details for the TUI", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 500 } } });
		const original = makeLines(600);
		const result = fireToolResult(h, {
			toolName: "bash",
			content: [textBlock(original)],
		});

		const text = firstText(result);
		expect(text).toContain("line 600");
		expect(text).not.toContain("line 100\n");
		expect(text).toMatch(/\[Showing 500 of 600 lines \(/);

		expect(result.details.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			outputLines: 500,
			totalLines: 600,
			// The TUI's "N lines shown (X limit)" warning renders from these:
			maxLines: 500,
			maxBytes: 51200,
		});
		const path = result.details.fullOutputPath;
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	it("points read results back at the source file instead of a temp copy", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		const result = fireToolResult(h, {
			input: { path: "/tmp/big.ts", offset: 51 },
			content: [textBlock(makeLines(600))],
		});

		const text = firstText(result);
		expect(text).toMatch(/\[Showing 100 of 600 lines /);
		// Kept file lines 51-150, so the next read continues at 151.
		expect(text).toContain("Use offset=151 to continue.");
		expect(text).not.toContain("Full output:");
	});

	it("assumes offset 1 for reads called without an offset", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		const result = fireToolResult(h, {
			input: { path: "/tmp/big.ts" },
			content: [textBlock(makeLines(600))],
		});
		expect(firstText(result)).toContain("Use offset=101 to continue.");
	});

	it("suggests bash when a read's first line alone exceeds the byte limit", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxBytes: 10 } } });
		const result = fireToolResult(h, {
			input: { path: "/tmp/oneline.txt" },
			content: [textBlock("a-single-line-way-over-ten-bytes-long")],
		});
		const text = firstText(result);
		expect(text).toContain("alone exceeds the byte limit; use bash");
		expect(text).not.toContain("Use offset=");
	});

	it("falls back to a temp file for read events without a source path", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		const original = makeLines(600);
		const result = fireToolResult(h, { content: [textBlock(original)] });
		const text = firstText(result);
		expect(text).toContain("Full output:");
		expect(readFileSync(footerPath(text), "utf-8")).toBe(original);
	});

	it("enforces byte limits", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxBytes: 100 } },
		});
		const result = fireToolResult(h, {
			content: [textBlock(makeLines(50, "a-much-longer-line-prefix"))],
		});
		const text = firstText(result);
		expect(text).toContain("limit 2000 lines/100B");
		expect(text).toMatch(/\[Showing \d+ of 50 lines \(/);
	});

	it("leaves non-text blocks untouched", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 500 } } });
		const image = { type: "image", data: "base64data", mimeType: "image/png" };
		// Only an image: nothing to change.
		expect(fireToolResult(h, { content: [image] })).toBeUndefined();
		// Mixed content: image passes through by identity, text is truncated.
		const result = fireToolResult(h, {
			content: [image, textBlock(makeLines(600))],
		});
		expect(result.content[0]).toBe(image);
		expect(result.content[1].text).toContain("[Showing 500 of 600 lines");
	});
});

describe("interaction with pi's built-in truncation", () => {
	const nativeReadFooter = "\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]";

	it("is a full no-op at exactly pi's limits: native footer is preserved", () => {
		const h = createHarness();
		startSession(h); // default config = pi's built-in limits
		const text = makeLines(2000) + nativeReadFooter;
		const result = fireToolResult(h, {
			content: [textBlock(text)],
			details: {
				truncation: {
					truncated: true,
					truncatedBy: "lines",
					outputLines: 2000,
					totalLines: 2500,
				},
			},
		});
		// Handler must not touch anything: the built-in footer stays as the
		// model's only source of truncation info.
		expect(result).toBeUndefined();
	});

	it("preserves native truncation when configured limits are higher than pi's", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 5000, maxBytes: 102400 } },
		});
		const text =
			makeLines(2000) +
			"\n\n[Showing lines 1-2000 of 3000 (50.0KB limit). Full output: /tmp/native-bash.log]";
		const result = fireToolResult(h, {
			toolName: "bash",
			content: [textBlock(text)],
			details: {
				truncation: {
					truncated: true,
					truncatedBy: "lines",
					outputLines: 2000,
					totalLines: 3000,
				},
				fullOutputPath: "/tmp/native-bash.log",
			},
		});
		// Built-in cut first at its own caps; we can't recover what it dropped,
		// and its footer (with the temp-file path) must survive.
		expect(result).toBeUndefined();
	});

	it("applies higher limits to extension tools that never truncate", () => {
		const h = createHarness();
		startSession(h, {
			globalSettings: { outputLimits: { maxLines: 5000, maxBytes: 102400 } },
		});
		// 3000 lines would be cut at the default 2000; passes with higher caps.
		expect(
			fireToolResult(h, {
				toolName: "mytool",
				content: [textBlock(makeLines(3000))],
			}),
		).toBeUndefined();
	});

	it("replaces the built-in footer with real counts when our limits are lower", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		const builtinText = makeLines(2000); // what read produced after its own cut
		const result = fireToolResult(h, {
			content: [textBlock(builtinText + nativeReadFooter)],
			details: {
				truncation: {
					truncated: true,
					truncatedBy: "lines",
					outputLines: 2000,
					totalLines: 2500,
					totalBytes: 25000,
				},
			},
		});

		const text = firstText(result);
		// Native footer is gone, ours reflects the TRUE totals from details.
		expect(text).not.toContain("Use offset");
		expect(text).toContain("[Showing 100 of 2500 lines");
		// The temp file holds what we received (2000 lines), not just 100.
		expect(readFileSync(footerPath(text), "utf-8")).toBe(builtinText);
	});

	it("reuses the built-in temp file instead of writing a second copy", () => {
		const h = createHarness();
		startSession(h, { globalSettings: { outputLimits: { maxLines: 100 } } });
		const result = fireToolResult(h, {
			toolName: "bash",
			content: [
				textBlock(
					makeLines(2000) +
						"\n\n[Showing lines 101-2000 of 3000. Full output: /tmp/native-bash.log]",
				),
			],
			details: {
				truncation: {
					truncated: true,
					truncatedBy: "lines",
					outputLines: 2000,
					totalLines: 3000,
				},
				fullOutputPath: "/tmp/native-bash.log",
			},
		});

		// The original native temp file is referenced, not a new one.
		expect(result.details.fullOutputPath).toBe("/tmp/native-bash.log");
		expect(firstText(result)).toContain("Full output: /tmp/native-bash.log");
		expect(result.details.truncation).toMatchObject({
			truncated: true,
			outputLines: 100,
			totalLines: 3000,
			maxLines: 100,
			maxBytes: 51200,
		});
	});
});
