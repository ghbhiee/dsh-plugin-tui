import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as readline from "node:readline";
import z from "@deepseek-ai/schemastery";
//#region src/host-modules.ts
/**
* Late-bound access to the harness packages this runner drives.
*
* These live in the profile's own tree, not in this plugin's. A plugin
* installed normally finds them by Node's parent walk, but one installed with
* `link:` (the usual dev loop) sits outside the profile directory and never
* reaches it. Resolving through `ctx.baseUrl` — the profile directory the
* loader booted from — covers both, and importing the resolved path keeps a
* single module instance shared with the host rather than a second copy.
*
* @module dsh-plugin-tui/host-modules
*/
/**
* Resolve one specifier against this module, then against the profile.
* @param specifier - bare package specifier.
* @param baseUrl - the loader's base URL, when the entry has one.
* @returns an absolute file URL for the module.
* @throws when no anchor resolves it, naming every path tried.
*/
function resolveHostModule(specifier, baseUrl) {
	const failures = [];
	for (const anchor of [import.meta.url, ...baseUrl === void 0 ? [] : [baseUrl]]) try {
		return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
	} catch (error) {
		failures.push(`${anchor}: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
	}
	throw new Error(`tui: cannot resolve "${specifier}" from the profile. Tried:\n` + failures.map((line) => `  - ${line}`).join("\n"));
}
/**
* Load the harness modules the runner needs.
* @param baseUrl - `ctx.baseUrl` of the runner entry.
* @returns the resolved harness entry points.
*/
async function loadHostModules(baseUrl) {
	const [agent, llm, session] = await Promise.all([
		import(resolveHostModule("@deepseek-ai/dsh-agent", baseUrl)),
		import(resolveHostModule("@deepseek-ai/dsh-llm", baseUrl)),
		import(resolveHostModule("@deepseek-ai/dsh-session", baseUrl))
	]);
	return {
		installModelSelection: agent.installModelSelection,
		createUserMessage: llm.createUserMessage,
		SessionId: session.SessionId
	};
}
//#endregion
//#region src/index.ts
/**
* TUI runner: a resident REPL over one resumable agent session.
*
* Where the one-shot CLI runner drives a single turn and exits, this runner
* owns the terminal for the whole conversation: it streams `session/event`
* facts (token deltas, tool calls, turn endings) straight to stdout, answers
* `approval/request` from the keyboard, and keeps the process alive until the
* user leaves with `/exit`, Ctrl-D, or a double Ctrl-C.
*
* Raw-mode readline owns Ctrl-C as a keystroke, so the launcher's SIGINT
* handler is reserved for external `kill -INT` — where a full teardown is the
* right response.
*
* @module dsh-plugin-tui
*/
/** Cordis plugin name. */
const name = "tui-runner";
/** Core services required before the REPL can start. */
const inject = [
	"agentDefaultModel",
	"agents",
	"sessions",
	"sessionPersistence",
	"userQuestions"
];
/** Runtime schema for {@link Config}. */
const Config = z.object({
	request: z.object({
		action: z.string().default("new"),
		task: z.string().default(""),
		sessionId: z.string().default(""),
		autoApprove: z.boolean().default(false),
		permission: z.string().default("")
	}),
	sessionTag: z.string().default("tui"),
	exitGraceMs: z.number().default(1500),
	sigintExitWindowMs: z.number().default(1500)
});
const DIM = "\x1B[2m";
const RESET = "\x1B[0m";
const CYAN = "\x1B[36m";
const YELLOW = "\x1B[33m";
const BOLD = "\x1B[1m";
const GREEN = "\x1B[32m";
/** Style inline markdown spans: `code`, **bold**, *italic*. Span-scoped codes, so surrounding state survives. */
function styleInlineMd(text) {
	return text.split(/(`[^`]+`)/).map((part) => {
		if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return `\x1b[36m${part.slice(1, -1)}\x1b[39m`;
		return part.replace(/\*\*([^*]+)\*\*/g, "\x1B[1m$1\x1B[22m").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s.,;:)!?])/g, "$1\x1B[3m$2\x1B[23m");
	}).join("");
}
/**
* Line-at-a-time markdown styling with the one piece of cross-line state that
* matters in a terminal: whether we are inside a fenced code block.
*/
var MdStyler = class {
	inFence = false;
	/** Style one complete line (without its newline). */
	line(text) {
		if (/^\s*(```|~~~)/.test(text)) {
			this.inFence = !this.inFence;
			return `${DIM}${text}${RESET}`;
		}
		if (this.inFence) return `${GREEN}${text}${RESET}`;
		if (/^(#{1,6}) (.*)$/.exec(text) !== null) return `${BOLD}${text}${RESET}`;
		if (/^\s*>/.test(text)) return `${DIM}${text}${RESET}`;
		const bullet = /^(\s*)([-*+]|\d{1,3}\.) (.*)$/.exec(text);
		if (bullet !== null) return `${bullet[1] ?? ""}${CYAN}${bullet[2] ?? ""}${RESET} ${styleInlineMd(bullet[3] ?? "")}`;
		return styleInlineMd(text);
	}
	/** Style a trailing fragment that never got its newline (end of turn). */
	fragment(text) {
		return this.inFence ? `${GREEN}${text}${RESET}` : styleInlineMd(text);
	}
};
const PROMPT = "\x1B[1m\x1B[35m»\x1B[0m ";
function sessionsInCwd(headers, cwd, tag) {
	return headers.filter((header) => header.cwd === cwd && header.agentPreset === tag).sort((a, b) => b.createdAt - a.createdAt);
}
function normalizeSessionId(id) {
	return id.startsWith("session-") ? id : `session-${id}`;
}
/** Last `session/title` payload in a log, or undefined before one exists. */
function titleFromEvents(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type === "session/title") return event.data.title;
	}
}
/** `3m ago` / `2h ago` / `5d ago` for session listings. */
function relativeAge(thenMs, nowMs) {
	const minutes = Math.max(0, Math.round((nowMs - thenMs) / 6e4));
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
/** `⏺` glyph color per tool-call category (presentation.d.ts's ToolCallKind). */
const TOOL_KIND_COLORS = {
	read: "\x1B[34m",
	edit: YELLOW,
	delete: "\x1B[31m",
	move: YELLOW,
	search: "\x1B[35m",
	execute: GREEN,
	fetch: "\x1B[34m",
	other: CYAN
};
/** Approximate terminal display width: CJK and fullwidth glyphs count as 2 columns. */
function displayWidth(text) {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		width += code >= 4352 && code <= 4447 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65103 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 262141 ? 2 : 1;
	}
	return width;
}
/** The leading portion of a string that fits within the given display columns, ellipsized. */
function clipByWidth(text, cols) {
	let width = 0;
	let result = "";
	for (const ch of text) {
		const w = displayWidth(ch);
		if (width + w > cols - 1) return `${result}…`;
		width += w;
		result += ch;
	}
	return result;
}
/** Split text into rows no wider than the given display columns. */
function wrapByWidth(text, cols) {
	const rows = [];
	let row = "";
	let width = 0;
	for (const ch of text) {
		const w = displayWidth(ch);
		if (width + w > cols) {
			rows.push(row);
			row = ch;
			width = w;
		} else {
			row += ch;
			width += w;
		}
	}
	if (row !== "") rows.push(row);
	return rows;
}
/** The trailing portion of a string that fits within the given display columns. */
function tailByWidth(text, cols) {
	const chars = [...text];
	let width = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i--) {
		const w = displayWidth(chars[i] ?? "");
		if (width + w > cols) break;
		width += w;
		start = i;
	}
	return chars.slice(start).join("");
}
/** Human-compact token count: 999 → '999', 12345 → '12.3k'. */
function fmtTokens(count) {
	if (count < 1e3) return String(count);
	const thousands = count / 1e3;
	return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}
/** Compress a raw tool-arguments JSON string into one dim line. */
function toolCallLabel(args, max = 100) {
	const flat = args.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
/**
* Fold a session log into user-visible exchanges for history replay: user
* text, assistant text, tool calls, and turn errors — no reasoning, no
* chunks. Non-user producers (goal, subagent splices) are skipped.
*/
function collectExchanges(events) {
	const exchanges = [];
	let current;
	for (const event of events) if (event.type === "user/message") {
		const data = event.data;
		if (data.source?.kind !== "user") continue;
		const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
		if (text.trim() === "") continue;
		current = {
			user: text,
			parts: []
		};
		exchanges.push(current);
	} else if (event.type === "assistant/message" && current !== void 0) {
		const text = (event.data.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
		if (text !== "") current.parts.push({
			kind: "text",
			text
		});
	} else if (event.type === "tool/call" && current !== void 0) {
		const data = event.data;
		current.parts.push({
			kind: "tool",
			text: "",
			toolName: data.name,
			args: data.arguments
		});
	} else if (event.type === "turn/end" && current !== void 0) {
		const reason = event.data.reason;
		if (reason?.kind === "error") current.parts.push({
			kind: "error",
			text: `${reason.error?.code ?? "error"}: ${reason.error?.message ?? ""}`
		});
	}
	return exchanges;
}
/**
* Read a persisted session's title without resuming it: `inspect` yields the
* immutable log, and the last `session/title` event wins. Every miss —
* backend without inspect, absent session, torn log — is just "no title".
*/
async function coldTitle(persistence, id) {
	try {
		const inspect = persistence.inspect;
		if (inspect === void 0) return void 0;
		const view = await inspect.call(persistence, id);
		if (process.env.TUI_DEBUG === "1") {
			const { appendFileSync } = await import("node:fs");
			appendFileSync("/tmp/tui-debug.log", `inspect ${id}: keys=${JSON.stringify(Object.keys(view ?? {}))} events=${String(view?.events?.length)}\n`);
		}
		return titleFromEvents(view?.events ?? []);
	} catch (error) {
		if (process.env.TUI_DEBUG === "1") {
			const { appendFileSync } = await import("node:fs");
			appendFileSync("/tmp/tui-debug.log", `inspect ${id} THREW: ${error instanceof Error ? error.message : String(error)}\n`);
		}
		return;
	}
}
/** Ask for a graceful shutdown, with a hard fallback so the process always exits. */
function exitNow(io, code) {
	io.exit(code);
	setTimeout(() => {
		process.exit(code);
	}, io.graceMs);
}
function fail(io, error) {
	io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
	exitNow(io, 1);
}
/** Reject a configuration that cannot do anything sensible. */
function assertRunnable(config) {
	if (config.sessionTag.trim() === "") throw new Error("tui-runner: sessionTag must not be empty; it is the label --list and --resume scope by");
	if (!Number.isFinite(config.exitGraceMs) || config.exitGraceMs < 0) throw new Error(`tui-runner: exitGraceMs must be a non-negative number, got ${String(config.exitGraceMs)}`);
}
const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
const SPINNER_INTERVAL_MS = 120;
const DELTA_FLUSH_MS = 16;
const DELTA_FLUSH_CHARS = 512;
/**
* Everything the streaming renderer needs to know about the terminal state:
* whether the cursor sits mid-line after a delta, and which block kind wrote
* last, so block transitions insert exactly one separator.
*
* Token deltas are micro-batched (a ~16ms window, force-flushed by size and
* before every structural line): `session/event` fires one synchronous
* listener call per token, and unbatched writes amplify straight into stdout
* syscalls. A braille spinner covers quiet stretches of a running turn; it
* only draws at column 0 and is erased before anything real is written.
*/
var Renderer = class Renderer {
	out;
	midLine = false;
	lastKind = "other";
	pending = "";
	pendingKind = void 0;
	md = new MdStyler();
	lineBuf = "";
	lineEmitted = 0;
	flushTimer = void 0;
	spinnerTimer = void 0;
	spinnerVisible = false;
	spinnerFrame = 0;
	spinnerRows = 1;
	lineIdleTimer = void 0;
	reasoningVisible;
	thinkingTail = "";
	turnDetail = "";
	constructor(out, opts) {
		this.out = out;
		this.reasoningVisible = opts?.reasoningVisible ?? false;
	}
	/** Whether the thinking stream currently prints in full. */
	get thinkingShown() {
		return this.reasoningVisible;
	}
	statusActive = false;
	/**
	* Reserve the terminal's last row as a fixed status bar by shrinking the
	* scroll region to the rows above it (DECSTBM). Everything the renderer
	* already does happens inside the region, so ordinary output scrolls while
	* the bar stays put. Call again (fresh=false) after a resize to re-fit.
	*/
	enableStatusBar(fresh = true) {
		const rows = this.out.rows;
		if (rows === void 0 || rows < 4) return;
		if (fresh) this.out.write("\n");
		this.out.write(`\x1b[1;${rows - 2}r\x1b[${rows - 2};1H`);
		this.statusActive = true;
	}
	/** Redraw the status bar content (clipped and padded to the full width). */
	setStatus(text) {
		if (!this.statusActive) return;
		const size = this.out;
		const rows = size.rows ?? 24;
		const cols = size.columns ?? 80;
		const clipped = clipByWidth(text, cols - 2);
		const rule = "─".repeat(Math.max(1, cols - 1));
		this.out.write(`\x1b7\x1b[${rows - 1};1H\x1b[2K\x1b[2m${rule}\x1b[0m\x1b[${rows};1H\x1b[2K\x1b[90m ${clipped}\x1b[0m\x1b8`);
	}
	/** Restore the full scroll region and blank the bar (leave/exit paths). */
	disableStatusBar() {
		if (!this.statusActive) return;
		const rows = this.out.rows ?? 24;
		this.out.write(`\x1b7\x1b[r\x1b[${rows - 1};1H\x1b[2K\x1b[${rows};1H\x1b[2K\x1b8`);
		this.statusActive = false;
	}
	/** Flip between the one-line thinking tail and the full dim stream. */
	toggleReasoning() {
		this.reasoningVisible = !this.reasoningVisible;
		if (this.reasoningVisible) {
			this.note("(thinking shown — ctrl+o to hide)");
			if (this.turnDetail !== "") {
				this.out.write(`${DIM}${this.turnDetail}${RESET}\n`);
				this.lastKind = "reasoning";
				this.midLine = false;
			}
			this.turnDetail = "";
			this.thinkingTail = "";
		} else this.note("(thinking hidden — ctrl+o to show)");
	}
	/** Erase a drawn spinner block (up to 3 rows) so real output never lands after it. */
	eraseSpinner() {
		if (!this.spinnerVisible) return;
		this.out.write("\r\x1B[2K");
		for (let i = 1; i < this.spinnerRows; i++) this.out.write("\x1B[1A\x1B[2K");
		this.spinnerVisible = false;
		this.spinnerRows = 1;
	}
	/**
	* Animate while a turn runs; draws only on an otherwise-quiet clean line.
	* With thinking collapsed, the spinner line doubles as the live one-line
	* tail of the reasoning stream.
	*/
	startSpinner() {
		if (this.spinnerTimer !== void 0) return;
		this.spinnerTimer = setInterval(() => {
			if (this.midLine || this.pending !== "") return;
			this.eraseSpinner();
			const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? "";
			const width = this.out.columns ?? 80;
			const budget = Math.max(20, width - 4);
			const rows = this.thinkingTail === "" ? ["…"] : wrapByWidth(this.thinkingTail, budget).slice(-3);
			const block = rows.map((row, i) => i === 0 ? `${DIM}${frame} ${row}${RESET}` : `${DIM}  ${row}${RESET}`).join("\n");
			this.out.write(block);
			this.spinnerRows = rows.length;
			this.spinnerVisible = true;
			this.spinnerFrame += 1;
		}, SPINNER_INTERVAL_MS);
		this.spinnerTimer.unref?.();
	}
	stopSpinner() {
		if (this.spinnerTimer !== void 0) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = void 0;
		}
		this.eraseSpinner();
		this.thinkingTail = "";
	}
	/** Forget the previous exchange's detail; called as a new exchange starts. */
	clearTurnDetail() {
		this.turnDetail = "";
	}
	/** Write out any batched deltas. Structural lines call this first. */
	flush() {
		if (this.flushTimer !== void 0) {
			clearTimeout(this.flushTimer);
			this.flushTimer = void 0;
		}
		if (this.pendingKind === void 0 || this.pending === "") {
			this.pendingKind = void 0;
			return;
		}
		const kind = this.pendingKind;
		const text = this.pending;
		this.pending = "";
		this.pendingKind = void 0;
		if (kind === "reasoning" && !this.reasoningVisible) {
			this.thinkingTail = `${this.thinkingTail}${text}`.replace(/\s+/g, " ").slice(-600);
			this.turnDetail = `${this.turnDetail}${text}`.slice(-8e3);
			return;
		}
		this.eraseSpinner();
		if (this.lastKind !== "other" && this.lastKind !== kind) this.breakLine();
		this.lastKind = kind;
		if (kind === "reasoning") {
			this.out.write(`${DIM}${text}${RESET}`);
			this.midLine = !text.endsWith("\n");
		} else this.emitText(text);
	}
	static RAW_LINE_THRESHOLD = 200;
	/**
	* Answer text is held until its line completes, then styled as markdown and
	* written whole — retroactive re-styling of a partially printed line would
	* need erase tricks that corrupt wrapped lines. A very long single-line run
	* escapes to raw streaming instead of sitting invisible in the buffer (its
	* later completion then skips styling: the head is already on screen).
	*/
	emitText(text) {
		this.lineBuf += text;
		for (;;) {
			const nl = this.lineBuf.indexOf("\n");
			if (nl === -1) break;
			const line = this.lineBuf.slice(0, nl);
			this.lineBuf = this.lineBuf.slice(nl + 1);
			if (this.lineEmitted > 0) {
				this.out.write(`${line.slice(this.lineEmitted)}\n`);
				this.lineEmitted = 0;
			} else this.out.write(`${this.md.line(line)}\n`);
			this.midLine = false;
		}
		if (this.lineBuf.length - this.lineEmitted > 0 && (this.lineEmitted > 0 || this.lineBuf.length > Renderer.RAW_LINE_THRESHOLD)) {
			this.out.write(this.lineBuf.slice(this.lineEmitted));
			this.lineEmitted = this.lineBuf.length;
			this.midLine = true;
		} else if (this.lineBuf.length > this.lineEmitted) {
			if (this.lineIdleTimer !== void 0) clearTimeout(this.lineIdleTimer);
			this.lineIdleTimer = setTimeout(() => {
				this.lineIdleTimer = void 0;
				if (this.lineBuf.length > this.lineEmitted) {
					this.eraseSpinner();
					this.out.write(this.lineBuf.slice(this.lineEmitted));
					this.lineEmitted = this.lineBuf.length;
					this.midLine = true;
				}
			}, 250);
			this.lineIdleTimer.unref?.();
		}
	}
	/** Put any buffered partial line on screen (inline-styled); turn boundaries call this. */
	dumpLine() {
		if (this.lineIdleTimer !== void 0) {
			clearTimeout(this.lineIdleTimer);
			this.lineIdleTimer = void 0;
		}
		if (this.lineBuf === "") {
			this.lineEmitted = 0;
			return;
		}
		const rest = this.lineBuf.slice(this.lineEmitted);
		if (rest !== "") {
			this.eraseSpinner();
			this.out.write(this.lineEmitted > 0 ? rest : this.md.fragment(rest));
		}
		this.midLine = true;
		this.lineBuf = "";
		this.lineEmitted = 0;
	}
	queueDelta(kind, text) {
		if (text === "") return;
		if (this.pendingKind !== void 0 && this.pendingKind !== kind) this.flush();
		this.pendingKind = kind;
		this.pending += text;
		if (this.pending.length >= DELTA_FLUSH_CHARS) {
			this.flush();
			return;
		}
		if (this.flushTimer === void 0) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = void 0;
				this.flush();
			}, DELTA_FLUSH_MS);
			this.flushTimer.unref?.();
		}
	}
	/** Ensure the cursor is at column 0 before a structural line. */
	breakLine() {
		this.flush();
		this.dumpLine();
		this.eraseSpinner();
		if (this.midLine) {
			this.out.write("\n");
			this.midLine = false;
		}
		this.lastKind = "other";
	}
	textDelta(text) {
		this.queueDelta("text", text);
	}
	reasoningDelta(text) {
		this.queueDelta("reasoning", text);
	}
	/**
	* A tool call renders as ONE summary line naming its task — never the full
	* command or code (a heredoc script used to land verbatim in the
	* transcript). The full input goes to the per-turn detail buffer instead,
	* where ctrl+o reveals it alongside the thinking stream.
	*/
	toolCall(name_, args, view) {
		this.breakLine();
		const kind = view?.card === "terminal" ? "execute" : view?.card === "diff" ? "edit" : view?.kind ?? "other";
		const glyph = `${TOOL_KIND_COLORS[kind] ?? CYAN}⏺${RESET}`;
		if (view?.title !== void 0) {
			const lines = view.title.split("\n");
			const first = lines[0] ?? "";
			const extra = lines.length - 1;
			const more = extra > 0 ? ` ${DIM}(+${extra} lines)${RESET}` : "";
			if (view.card === "terminal") {
				const label = view.description ?? `$ ${clipByWidth(first, 70)}`;
				this.out.write(`${glyph} ${BOLD}${label}${RESET}${more}\n`);
				this.detailBlock(name_, view.title);
			} else {
				const description = view.description === void 0 ? "" : ` ${DIM}— ${view.description}${RESET}`;
				this.out.write(`${glyph} ${BOLD}${clipByWidth(first, 70)}${RESET}${description}${more}\n`);
				if (extra > 0) this.detailBlock(name_, view.title);
			}
		} else {
			this.out.write(`${glyph} ${name_} ${DIM}${toolCallLabel(args, 80)}${RESET}\n`);
			if (args.length > 80) this.detailBlock(name_, args);
		}
	}
	/**
	* Route a tool's full input to the turn's detail stream: printed dim when
	* thinking is shown, otherwise buffered for a later ctrl+o — which always
	* reveals only the CURRENT turn (the buffer clears when the turn settles).
	*/
	detailBlock(tool, body) {
		const block = `── ${tool} ──\n${body}\n`;
		if (this.reasoningVisible) {
			this.out.write(`${DIM}${block}${RESET}`);
			this.midLine = false;
			this.lastKind = "other";
		} else this.turnDetail = `${this.turnDetail}${block}`.slice(-8e3);
	}
	toolError(code) {
		this.breakLine();
		this.out.write(`${YELLOW}  ⚠ ${code}${RESET}\n`);
	}
	turnError(code, message) {
		this.breakLine();
		this.out.write(`${YELLOW}✖ ${code}: ${message}${RESET}\n`);
	}
	/** Latest-wins todo snapshot as a compact checklist. */
	todoList(todos) {
		this.breakLine();
		for (const todo of todos) {
			const glyph = todo.status === "completed" ? `${GREEN}☑${RESET}` : todo.status === "in_progress" ? `${YELLOW}◐${RESET}` : `${DIM}☐${RESET}`;
			const body = todo.status === "completed" ? `${DIM}${todo.content}${RESET}` : todo.content;
			this.out.write(`  ${glyph} ${body}\n`);
		}
	}
	/** One dim per-exchange accounting line. */
	usageLine(usage) {
		this.breakLine();
		const parts = [`${fmtTokens(usage.inputTokens)} in`, `${fmtTokens(usage.outputTokens)} out`];
		if (usage.cacheReadTokens !== void 0 && usage.cacheReadTokens > 0) parts.push(`${fmtTokens(usage.cacheReadTokens)} cached`);
		if (usage.reasoningTokens !== void 0 && usage.reasoningTokens > 0) parts.push(`${fmtTokens(usage.reasoningTokens)} reasoning`);
		this.out.write(`${DIM}↳ ${parts.join(" · ")}${RESET}\n`);
	}
	note(text) {
		this.breakLine();
		this.out.write(`${DIM}${text}${RESET}\n`);
	}
};
async function run(ctx, config, io) {
	const request = config.request;
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const persistence = ctx.get("sessionPersistence");
	const defaultModel = ctx.get("agentDefaultModel");
	if (agents === void 0 || sessions === void 0 || persistence === void 0 || defaultModel === void 0) return;
	const cwd = process.cwd();
	if (request.action === "list") {
		const mine = sessionsInCwd(await persistence.list(), cwd, config.sessionTag);
		if (mine.length === 0) io.stdout.write(`(no ${config.sessionTag} sessions for ${cwd})\n`);
		else for (const header of mine) {
			const title = await coldTitle(persistence, header.id) ?? "";
			io.stdout.write(`${header.id}\t${new Date(header.createdAt).toISOString()}\t${title}\n`);
		}
		exitNow(io, 0);
		return;
	}
	const { installModelSelection, createUserMessage, SessionId } = await loadHostModules(ctx.baseUrl);
	const selectionRef = {
		current: defaultModel.currentSelection(),
		assembled: void 0
	};
	const currentSelection = () => selectionRef.current ?? defaultModel.currentSelection();
	const profileDir = (() => {
		try {
			return ctx.baseUrl === void 0 ? void 0 : fileURLToPath(new URL(".", ctx.baseUrl));
		} catch {
			return;
		}
	})();
	const modelPrefPath = profileDir === void 0 ? void 0 : join(profileDir, "tui-model.json");
	if (modelPrefPath !== void 0) try {
		const pref = JSON.parse(readFileSync(modelPrefPath, "utf8"));
		if (typeof pref.provider === "string" && typeof pref.model === "string") selectionRef.current = {
			provider: pref.provider,
			model: pref.model,
			...typeof pref.reasoningEffort === "string" ? { reasoningEffort: pref.reasoningEffort } : {}
		};
	} catch {}
	const setSelection = (next) => {
		selectionRef.current = next;
		if (modelPrefPath === void 0) return;
		try {
			writeFileSync(modelPrefPath, `${JSON.stringify(next)}\n`);
		} catch {}
	};
	const clearSelectionPref = () => {
		selectionRef.current = defaultModel.currentSelection();
		if (modelPrefPath === void 0) return;
		try {
			rmSync(modelPrefPath, { force: true });
		} catch {}
	};
	const setup = (agentCtx) => {
		installModelSelection(agentCtx, selectionRef);
	};
	const agentOptions = () => ({
		provider: currentSelection().provider,
		model: currentSelection().model
	});
	let handle;
	let sessionId;
	if (request.action === "new") {
		sessionId = `session-${randomUUID()}`;
		handle = await agents.create({
			sessionId: SessionId(sessionId),
			meta: {
				cwd,
				agentPreset: config.sessionTag
			},
			agentOptions: agentOptions(),
			setup
		});
	} else {
		const resolved = request.action === "resume-session" ? normalizeSessionId(request.sessionId) : sessionsInCwd(await persistence.list(), cwd, config.sessionTag)[0]?.id;
		if (resolved === void 0) {
			io.stderr.write(`dsh: no ${config.sessionTag} session to resume in ${cwd}\n`);
			exitNow(io, 1);
			return;
		}
		sessionId = resolved;
		handle = await agents.resume({
			resumeSessionId: SessionId(sessionId),
			agentOptions: agentOptions(),
			setup
		});
	}
	let agent = handle.agent;
	io.stderr.write(`session: ${sessionId}\n`);
	let resumedMidTurn = false;
	if (request.action !== "new" && agent.status === "running") {
		resumedMidTurn = true;
		agent.cancel({ kind: "user" });
	}
	await agent.whenIdle();
	const render = new Renderer(io.stdout);
	const exchangeUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		reasoningTokens: 0,
		steps: 0
	};
	const resetUsage = () => {
		exchangeUsage.inputTokens = 0;
		exchangeUsage.outputTokens = 0;
		exchangeUsage.cacheReadTokens = 0;
		exchangeUsage.reasoningTokens = 0;
		exchangeUsage.steps = 0;
	};
	const toolView = (toolName, rawArgs) => {
		try {
			return ctx.get("tools")?.get(toolName)?.presentCall?.(JSON.parse(rawArgs));
		} catch {
			return;
		}
	};
	ctx.on("session/event", (session, event) => {
		if (session !== agent.session) return;
		const typed = event;
		if (typed.type === "assistant/chunk") {
			const { chunk } = typed.data;
			if (chunk.type === "text-delta") render.textDelta(chunk.text ?? "");
			else if (chunk.type === "reasoning-delta") render.reasoningDelta(chunk.text ?? "");
		} else if (typed.type === "tool/call") {
			const data = typed.data;
			render.toolCall(data.name, data.arguments, toolView(data.name, data.arguments));
		} else if (typed.type === "tool/result") {
			const data = typed.data;
			if (data.error !== void 0) render.toolError(data.error.code);
		} else if (typed.type === "turn/end") {
			const reason = typed.data.reason;
			if (reason?.kind === "error") render.turnError(reason.error?.code ?? "error", reason.error?.message ?? "");
		} else if (typed.type === "todo/write") {
			const todos = typed.data.todos;
			if (todos !== void 0 && todos.length > 0) render.todoList(todos);
		} else if (typed.type === "assistant/message") {
			const usage = typed.data.usage;
			if (usage !== void 0) {
				exchangeUsage.inputTokens += usage.inputTokens ?? 0;
				exchangeUsage.outputTokens += usage.outputTokens ?? 0;
				exchangeUsage.cacheReadTokens += usage.cacheReadTokens ?? 0;
				exchangeUsage.reasoningTokens += usage.reasoningTokens ?? 0;
				exchangeUsage.steps += 1;
			}
		}
	});
	const historyPath = profileDir === void 0 ? void 0 : join(profileDir, "tui-history.txt");
	let initialHistory = [];
	if (historyPath !== void 0) try {
		initialHistory = readFileSync(historyPath, "utf8").split("\n").filter((line) => line !== "").slice(0, 200);
	} catch {
		initialHistory = [];
	}
	const saveHistory = (entries) => {
		if (historyPath === void 0) return;
		try {
			writeFileSync(historyPath, `${entries.slice(0, 200).join("\n")}\n`);
		} catch {}
	};
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: process.stdin.isTTY === true,
		history: initialHistory,
		historySize: 200
	});
	let historyTimer;
	rl.on("history", (entries) => {
		if (historyTimer !== void 0) clearTimeout(historyTimer);
		historyTimer = setTimeout(() => {
			saveHistory(entries);
		}, 500);
		historyTimer.unref?.();
	});
	if (process.stdin.isTTY === true) {
		readline.emitKeypressEvents(process.stdin, rl);
		process.stdin.on("keypress", (_str, key) => {
			if (key?.ctrl === true && key.name === "o") render.toggleReasoning();
			setImmediate(() => {
				repaintStatus();
			});
		});
	}
	let running = false;
	let closing = false;
	let lastSigint = 0;
	let repaintStatus = () => {};
	const leave = (code) => {
		if (closing) return;
		closing = true;
		render.stopSpinner();
		render.disableStatusBar();
		saveHistory(rl.history ?? []);
		rl.close();
		sessions.flush(agent.session).catch(() => void 0).then(() => {
			exitNow(io, code);
		});
	};
	rl.on("close", () => {
		if (!closing) leave(0);
	});
	rl.on("SIGINT", () => {
		if (running) {
			agent.cancel({ kind: "user" });
			render.note("(turn cancelled)");
			return;
		}
		const now = Date.now();
		if (now - lastSigint < config.sigintExitWindowMs) {
			leave(130);
			return;
		}
		lastSigint = now;
		render.note("(^C again to exit, or press Enter for a prompt)");
	});
	const question = () => new Promise((resolve) => {
		const cols = process.stdout.columns ?? 80;
		io.stdout.write(`${DIM}${"─".repeat(Math.max(20, Math.min(cols - 1, 100)))}${RESET}\n`);
		rl.question(PROMPT, resolve);
		repaintStatus();
	});
	const askLine = (prompt, signal) => new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(/* @__PURE__ */ new Error("question aborted"));
			return;
		}
		const onAbort = () => {
			reject(/* @__PURE__ */ new Error("question aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		rl.question(prompt, (answer) => {
			signal?.removeEventListener("abort", onAbort);
			resolve(answer);
		});
		repaintStatus();
	});
	let approvalMode = request.autoApprove ? "auto" : "ask";
	let approvalHintShown = false;
	ctx.on("approval/request", (approval, next) => {
		if (approval.agent !== agent) return next();
		const reason = approval.reason === void 0 ? "" : ` ${DIM}(${approval.reason})${RESET}`;
		if (approvalMode === "auto") {
			render.note(`⚠ auto-approved: ${approval.toolName}${approval.reason === void 0 ? "" : ` — ${clipByWidth(approval.reason, 70)}`}`);
			return Promise.resolve("allowed-once");
		}
		render.breakLine();
		render.stopSpinner();
		return new Promise((resolve) => {
			rl.question(`${YELLOW}⚠ allow tool "${approval.toolName}"?${RESET}${reason} [y/N] `, (answer) => {
				if (running) render.startSpinner();
				repaintStatus();
				if (!approvalHintShown) {
					approvalHintShown = true;
					render.note("(tip: /approvals auto allows everything for this session; dsh --profile tui -y does it from launch)");
				}
				resolve(/^y(es)?$/i.test(answer.trim()) ? "allowed-once" : "rejected");
			});
		});
	});
	const answerQuestions = async (request) => {
		render.stopSpinner();
		const answers = [];
		for (const item of request.questions) {
			render.breakLine();
			const head = item.header === void 0 ? "" : `[${item.header}] `;
			io.stdout.write(`${YELLOW}⁇ ${head}${item.question}${RESET}\n`);
			if (item.detail !== void 0 && item.detail !== "") io.stdout.write(`${DIM}${item.detail}${RESET}\n`);
			const options = item.options ?? [];
			options.forEach((option, index) => {
				const description = option.description === void 0 ? "" : ` ${DIM}— ${option.description}${RESET}`;
				io.stdout.write(`  ${index + 1}) ${option.label}${description}\n`);
			});
			const hint = options.length === 0 ? "answer" : item.multiSelect === true ? `pick 1-${options.length} (comma-separated) or type an answer` : `pick 1-${options.length} or type an answer`;
			const raw = (await askLine(`${hint}: `, request.signal)).trim();
			const picks = raw.split(/[\s,]+/).filter((part) => part !== "");
			const indices = picks.map((part) => Number.parseInt(part, 10));
			if (options.length > 0 && picks.length > 0 && indices.every((value) => Number.isInteger(value) && value >= 1 && value <= options.length)) {
				const chosen = (item.multiSelect === true ? indices : indices.slice(0, 1)).map((value) => options[value - 1]?.label ?? "");
				answers.push({
					id: item.id,
					selected: chosen
				});
			} else answers.push({
				id: item.id,
				selected: [],
				...raw === "" ? {} : { custom: raw }
			});
		}
		if (running) render.startSpinner();
		return { answers };
	};
	const questionService = ctx.get("userQuestions");
	if (questionService !== void 0 && typeof questionService.registerProvider === "function") questionService.registerProvider({ ask: answerQuestions });
	else ctx.on("user-questions/request", (request, next) => {
		if (request.agent !== void 0 && request.agent !== agent) return next();
		return answerQuestions(request);
	});
	const execCommand = async (line) => {
		const commands = ctx.get("commands");
		if (commands === void 0) return void 0;
		const signal = new AbortController().signal;
		const execute = commands.execute.bind(commands);
		return commands.execute.length >= 4 ? await execute(agent, line, [], signal) : await execute(agent, line, signal);
	};
	if (process.stdout.isTTY === true) render.enableStatusBar();
	else {
		const bannerSel = currentSelection();
		const bannerEffort = bannerSel.reasoningEffort === void 0 ? "" : ` (${String(bannerSel.reasoningEffort)})`;
		render.note(`${bannerSel.provider}/${bannerSel.model}${bannerEffort} · ${cwd} · /exit to quit · ctrl+o thinking`);
	}
	let lastListing = [];
	const listMine = async () => {
		lastListing = sessionsInCwd(await persistence.list(), cwd, config.sessionTag);
		return lastListing;
	};
	const liveTitle = () => ctx.get("sessionTitle")?.get(agent.session)?.title;
	const printSessions = async () => {
		const mine = await listMine();
		const lines = [];
		if (!mine.some((header) => header.id === sessionId)) lines.push(`*  ${liveTitle() ?? "(new session)"} · ${sessionId.replace("session-", "").slice(0, 8)}`);
		if (mine.length === 0 && lines.length === 0) {
			render.note(`(no ${config.sessionTag} sessions for ${cwd})`);
			return;
		}
		for (const [index, header] of mine.entries()) {
			const marker = header.id === sessionId ? "*" : " ";
			const title = (header.id === sessionId ? liveTitle() : void 0) ?? await coldTitle(persistence, header.id) ?? "(untitled)";
			lines.push(`${marker}${index + 1}) ${title} · ${relativeAge(header.createdAt, Date.now())} · ${header.id.replace("session-", "").slice(0, 8)}`);
		}
		render.note(lines.join("\n"));
	};
	const switchTo = async (target) => {
		const previous = handle;
		try {
			if (target.kind === "new") {
				const freshId = `session-${randomUUID()}`;
				const fresh = await agents.create({
					sessionId: SessionId(freshId),
					meta: {
						cwd,
						agentPreset: config.sessionTag
					},
					agentOptions: agentOptions(),
					setup
				});
				handle = fresh;
				agent = fresh.agent;
				sessionId = freshId;
			} else {
				const fresh = await agents.resume({
					resumeSessionId: SessionId(target.id),
					agentOptions: agentOptions(),
					setup
				});
				handle = fresh;
				agent = fresh.agent;
				sessionId = target.id;
			}
		} catch (error) {
			render.turnError("session", error instanceof Error ? error.message : String(error));
			return;
		}
		if (target.kind === "resume" && agent.status === "running") {
			agent.cancel({ kind: "user" });
			render.note("(the resumed session had an unfinished turn — cancelled)");
		}
		await agent.whenIdle();
		io.stderr.write(`session: ${sessionId}\n`);
		render.note(`switched to ${liveTitle() ?? sessionId}`);
		if (target.kind === "resume") renderHistoryTail();
		else historyShownFrom = 0;
		try {
			await sessions.flush(previous.agent.session);
			await previous.dispose();
		} catch {}
	};
	const resolveTarget = async (arg) => {
		const index = Number.parseInt(arg, 10);
		if (Number.isInteger(index) && String(index) === arg && index >= 1) return (lastListing.length > 0 ? lastListing : await listMine())[index - 1]?.id;
		const mine = await listMine();
		const normalized = normalizeSessionId(arg);
		const exact = mine.find((header) => header.id === normalized);
		if (exact !== void 0) return exact.id;
		const byPrefix = mine.filter((header) => header.id.replace("session-", "").startsWith(arg));
		return byPrefix.length === 1 ? byPrefix[0]?.id : void 0;
	};
	/**
	* Inline arrow-key picker: draws heading + rows in place, ↑/↓ (or j/k)
	* move, Enter picks, Esc/q cancels. The selector borrows the keypress feed
	* wholesale — readline's own listener is parked so navigation keys neither
	* echo nor edit the line — then everything is restored exactly as found.
	* @returns the picked row index, or undefined on cancel.
	*/
	const pickFromList = async (heading, rows, startIndex, footer) => {
		let index = Math.min(Math.max(0, startIndex), rows.length - 1);
		render.breakLine();
		const extraLines = footer === void 0 ? 0 : 1;
		const draw = (first) => {
			if (!first) io.stdout.write(`\x1b[${rows.length + 1 + extraLines}A`);
			io.stdout.write(`\x1b[2K${DIM}${heading}${RESET}\n`);
			rows.forEach((row, i) => {
				io.stdout.write(`\x1b[2K${i === index ? `${CYAN}▸ ${row}${RESET}` : `  ${DIM}${row}${RESET}`}\n`);
			});
			if (footer !== void 0) io.stdout.write(`\x1b[2K${DIM}${footer}${RESET}\n`);
		};
		draw(true);
		return new Promise((resolve) => {
			const saved = [...process.stdin.listeners("keypress")];
			process.stdin.removeAllListeners("keypress");
			const finish = (value) => {
				process.stdin.removeAllListeners("keypress");
				for (const listener of saved) process.stdin.on("keypress", listener);
				resolve(value);
			};
			process.stdin.on("keypress", (_str, key) => {
				if (key === void 0) return;
				if (key.name === "up" || key.name === "k") {
					index = Math.max(0, index - 1);
					draw(false);
				} else if (key.name === "down" || key.name === "j") {
					index = Math.min(rows.length - 1, index + 1);
					draw(false);
				} else if (key.name === "return" || key.name === "enter") finish(index);
				else if (key.name === "escape" || key.name === "q" || key.ctrl === true && key.name === "c") finish(void 0);
			});
		});
	};
	const runSessionSelector = async () => {
		const mine = await listMine();
		if (mine.length === 0) {
			render.note(`(no ${config.sessionTag} sessions for ${cwd})`);
			return;
		}
		if (process.stdin.isTTY !== true) {
			await printSessions();
			return;
		}
		const MAX_ROWS = 15;
		const entries = mine.slice(0, MAX_ROWS);
		const rows = [];
		for (const header of entries) {
			const title = (header.id === sessionId ? liveTitle() : void 0) ?? await coldTitle(persistence, header.id) ?? "(untitled)";
			const marker = header.id === sessionId ? " (current)" : "";
			rows.push(`${title} · ${relativeAge(header.createdAt, Date.now())} · ${header.id.replace("session-", "").slice(0, 8)}${marker}`);
		}
		const footer = mine.length > MAX_ROWS ? `… ${mine.length - MAX_ROWS} more — /resume <id> reaches them` : void 0;
		const chosen = await pickFromList("select a session — ↑/↓ move · enter switch · esc cancel", rows, 0, footer);
		if (chosen === void 0) {
			render.note("(cancelled)");
			return;
		}
		const target = entries[chosen];
		if (target === void 0) return;
		if (target.id === sessionId) {
			render.note("already on that session");
			return;
		}
		await switchTo({
			kind: "resume",
			id: target.id
		});
	};
	const HISTORY_TAIL = 2;
	let historyShownFrom = 0;
	const sessionExchanges = () => collectExchanges(agent.session.events);
	const renderExchange = (exchange) => {
		render.breakLine();
		io.stdout.write(`${DIM}» ${exchange.user}${RESET}\n`);
		for (const part of exchange.parts) if (part.kind === "tool") render.toolCall(part.toolName ?? "?", part.args ?? "", toolView(part.toolName ?? "", part.args ?? "{}"));
		else if (part.kind === "error") render.turnError("history", part.text);
		else {
			render.textDelta(part.text.endsWith("\n") ? part.text : `${part.text}\n`);
			render.breakLine();
		}
	};
	const renderHistoryTail = () => {
		const exchanges = sessionExchanges();
		historyShownFrom = Math.max(0, exchanges.length - HISTORY_TAIL);
		if (historyShownFrom > 0) render.note(`… ${historyShownFrom} earlier exchange${historyShownFrom === 1 ? "" : "s"} hidden — /history ${Math.min(5, historyShownFrom)} shows more`);
		for (const exchange of exchanges.slice(historyShownFrom)) renderExchange(exchange);
	};
	if (request.permission !== "") try {
		const execution = await execCommand(`/permission ${request.permission}`);
		if (execution === void 0) render.note("permission: the /permission command is not registered in this profile");
		else if (execution.result.kind === "error") render.turnError("permission", execution.result.text ?? execution.result.kind);
		else render.note(execution.result.text ?? execution.result.kind);
	} catch (error) {
		render.turnError("permission", error instanceof Error ? error.message : String(error));
	}
	if (resumedMidTurn) render.note("(the resumed session had an unfinished turn — cancelled)");
	if (request.action === "resume-last" || request.action === "resume-session") renderHistoryTail();
	const statusText = () => {
		const sel = currentSelection();
		const effort = sel.reasoningEffort === void 0 ? "" : ` (${String(sel.reasoningEffort)})`;
		const title = liveTitle() ?? sessionId.replace("session-", "").slice(0, 8);
		return `${sel.provider}/${sel.model}${effort} · approvals:${approvalMode} · ${title} · ${cwd} · ctrl+o thinking · /help`;
	};
	const updateStatus = () => {
		render.setStatus(statusText());
	};
	repaintStatus = updateStatus;
	if (process.stdout.isTTY === true) {
		process.stdout.on("resize", () => {
			render.enableStatusBar(false);
			updateStatus();
		});
		process.once("exit", () => {
			render.disableStatusBar();
		});
	}
	updateStatus();
	let pending = request.task === "" ? void 0 : request.task;
	for (;;) {
		updateStatus();
		let line;
		if (pending === void 0) line = await question();
		else {
			line = pending;
			pending = void 0;
			io.stdout.write(`${PROMPT}${line}\n`);
		}
		if (closing) return;
		const text = line.trim();
		if (text === "") continue;
		if (text.startsWith("/")) {
			if (text === "/exit" || text === "/quit") {
				leave(0);
				return;
			}
			if (text === "/session") {
				render.note(sessionId);
				continue;
			}
			if (text === "/sessions") {
				await runSessionSelector();
				continue;
			}
			if (text === "/sessions list") {
				await printSessions();
				continue;
			}
			if (text === "/new") {
				await switchTo({ kind: "new" });
				continue;
			}
			if (text === "/resume" || text.startsWith("/resume ")) {
				const arg = text.slice(7).trim();
				if (arg === "") {
					render.note("usage: /resume <index|id> — /sessions lists them");
					continue;
				}
				const id = await resolveTarget(arg);
				if (id === void 0) render.note(`no ${config.sessionTag} session matches "${arg}" here`);
				else if (id === sessionId) render.note("already on that session");
				else await switchTo({
					kind: "resume",
					id
				});
				continue;
			}
			if (text === "/approvals" || text.startsWith("/approvals ")) {
				const arg = text.slice(10).trim();
				if (arg === "") render.note(`approvals: ${approvalMode} — usage: /approvals ask|auto`);
				else if (arg === "auto") {
					approvalMode = "auto";
					render.note("approvals: auto — every request is allowed with an audit line (the sandbox still applies); /approvals ask restores prompts");
				} else if (arg === "ask") {
					approvalMode = "ask";
					render.note("approvals: ask — each request prompts y/N again");
				} else render.note("usage: /approvals ask|auto");
				continue;
			}
			if (text === "/history" || text.startsWith("/history ")) {
				const arg = text.slice(8).trim();
				const count = arg === "" ? 5 : Number.parseInt(arg, 10);
				if (!Number.isInteger(count) || count < 1) {
					render.note("usage: /history [n]");
					continue;
				}
				if (historyShownFrom === 0) {
					render.note("(already at the start of the session)");
					continue;
				}
				const exchanges = sessionExchanges();
				const from = Math.max(0, historyShownFrom - count);
				render.note(`── earlier exchanges ${from + 1}–${historyShownFrom} of ${exchanges.length} ──`);
				for (const exchange of exchanges.slice(from, historyShownFrom)) renderExchange(exchange);
				historyShownFrom = from;
				if (from === 0) render.note("(start of session)");
				continue;
			}
			if (text === "/title" || text.startsWith("/title ")) {
				const arg = text.slice(6).trim();
				const titles = ctx.get("sessionTitle");
				if (titles === void 0) {
					render.note("session-title service unavailable");
					continue;
				}
				if (arg === "") {
					render.note(titles.get(agent.session)?.title ?? "(untitled)");
					continue;
				}
				try {
					render.note(`title: ${titles.rename(agent.session, arg).title}`);
				} catch (error) {
					render.turnError("title", error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const arg = text.slice(6).trim();
				const llm = ctx.get("llm");
				const sel = currentSelection();
				if (arg === "") {
					let catalog = [];
					try {
						catalog = (await llm?.listModels(sel.provider) ?? []).map((raw) => raw).filter((info) => info.id !== void 0);
					} catch {}
					if (process.stdin.isTTY === true && catalog.length > 0) {
						const rows = catalog.map((info) => {
							const label = info.name !== void 0 && info.name !== info.id ? ` — ${info.name}` : "";
							return `${info.id}${label}${info.id === sel.model ? " (current)" : ""}`;
						});
						const start = Math.max(0, catalog.findIndex((info) => info.id === sel.model));
						const chosen = await pickFromList(`select a model (${sel.provider}) — ↑/↓ · enter · esc`, rows, start, "or type /model <provider>/<id> for another provider");
						if (chosen === void 0) {
							render.note("(cancelled)");
							continue;
						}
						const picked = catalog[chosen];
						if (picked === void 0 || picked.id === sel.model) {
							render.note(`model: ${sel.provider}/${sel.model} (unchanged)`);
							continue;
						}
						setSelection({
							provider: sel.provider,
							model: picked.id
						});
						render.note(`model: ${sel.provider}/${picked.id} (from the next step; remembered for this profile)`);
						continue;
					}
					const lines = [`${sel.provider}/${sel.model}${sel.reasoningEffort === void 0 ? "" : ` · effort ${String(sel.reasoningEffort)}`}`];
					for (const info of catalog) {
						const label = info.name !== void 0 && info.name !== info.id ? ` — ${info.name}` : "";
						lines.push(`${info.id === sel.model ? "*" : " "} ${info.id}${label}`);
					}
					lines.push("usage: /model <id> · /model <provider>/<id> · /model default");
					render.note(lines.join("\n"));
					continue;
				}
				if (arg === "default") {
					clearSelectionPref();
					const back = currentSelection();
					render.note(`model: ${back.provider}/${back.model} (machine default restored; preference cleared)`);
					continue;
				}
				const slash = arg.indexOf("/");
				const provider = slash === -1 ? sel.provider : arg.slice(0, slash);
				const model = slash === -1 ? arg : arg.slice(slash + 1);
				try {
					if (llm !== void 0) {
						await llm.resolveModelInfo(provider, model);
						if (!(await llm.listModels(provider).catch(() => [])).some((info) => info.id === model)) render.note(`warning: "${model}" is not in ${provider}'s catalog — a wrong id fails at the next request`);
					}
					setSelection({
						provider,
						model
					});
					render.note(`model: ${provider}/${model} (from the next step; remembered for this profile)`);
				} catch (error) {
					render.turnError("model", error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (text === "/effort" || text.startsWith("/effort ")) {
				const arg = text.slice(7).trim();
				const sel = currentSelection();
				const llm = ctx.get("llm");
				let efforts = [];
				try {
					efforts = ((await llm?.resolveModelInfo(sel.provider, sel.model))?.reasoning?.efforts ?? []).map((effort) => String(effort.id));
				} catch {}
				if (arg === "") {
					if (process.stdin.isTTY === true && efforts.length > 0) {
						const rows = [`(provider default)${sel.reasoningEffort === void 0 ? " (current)" : ""}`, ...efforts.map((id) => `${id}${id === String(sel.reasoningEffort) ? " (current)" : ""}`)];
						const start = sel.reasoningEffort === void 0 ? 0 : efforts.indexOf(String(sel.reasoningEffort)) + 1;
						const chosen = await pickFromList(`select reasoning effort (${sel.model}) — ↑/↓ · enter · esc`, rows, Math.max(0, start));
						if (chosen === void 0) {
							render.note("(cancelled)");
							continue;
						}
						if (chosen === 0) {
							setSelection({
								provider: sel.provider,
								model: sel.model
							});
							render.note("effort: provider default (from the next step; remembered)");
						} else {
							const picked = efforts[chosen - 1];
							if (picked === void 0) continue;
							setSelection({
								provider: sel.provider,
								model: sel.model,
								reasoningEffort: picked
							});
							render.note(`effort: ${picked} (from the next step; remembered)`);
						}
						continue;
					}
					render.note([
						`effort: ${sel.reasoningEffort === void 0 ? "(provider default)" : String(sel.reasoningEffort)}`,
						...efforts.map((id) => `${id === String(sel.reasoningEffort) ? "*" : " "} ${id}`),
						"usage: /effort <id> or /effort default"
					].join("\n"));
					continue;
				}
				if (arg === "default") {
					setSelection({
						provider: sel.provider,
						model: sel.model
					});
					render.note("effort: provider default (from the next step; remembered)");
					continue;
				}
				if (efforts.length > 0 && !efforts.includes(arg)) {
					render.note(`unknown effort "${arg}" — available: ${efforts.join(", ")}`);
					continue;
				}
				setSelection({
					provider: sel.provider,
					model: sel.model,
					reasoningEffort: arg
				});
				render.note(`effort: ${arg} (from the next step; remembered)`);
				continue;
			}
			const commands = ctx.get("commands");
			if (text === "/help") {
				const registered = commands === void 0 ? [] : commands.list(agent).map((c) => `/${c.name} — ${c.description}`);
				render.note(["/exit · /session · /sessions · /new · /resume <n|id> · /history [n] · /title [text] · /model [id] · /effort [id] · /approvals [ask|auto] · Ctrl-C cancels a running turn (twice to quit)", ...registered].join("\n"));
				continue;
			}
			if (commands !== void 0) {
				try {
					const execution = await execCommand(text);
					if (execution === void 0) render.note("unknown command — /help lists what this profile offers");
					else if (execution.result.kind === "error") render.turnError("command", execution.result.text ?? execution.result.kind);
					else render.note(execution.result.text ?? execution.result.kind);
				} catch (error) {
					render.turnError("command", error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			render.note("unknown command (no command registry in this profile)");
			continue;
		}
		running = true;
		resetUsage();
		render.clearTurnDetail();
		render.startSpinner();
		agent.followup(createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: { kind: "user" }
		}));
		await agent.whenIdle();
		running = false;
		render.stopSpinner();
		render.breakLine();
		if (exchangeUsage.steps > 0) render.usageLine(exchangeUsage);
		await sessions.flush(agent.session);
	}
}
/** Mount the REPL and keep the process alive until the user leaves. */
function apply(ctx, config) {
	assertRunnable(config);
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("tui-runner: the launcher must provide ctx.appExit before the tree mounts");
	const io = {
		stdout: process.stdout,
		stderr: process.stderr,
		exit,
		graceMs: config.exitGraceMs
	};
	run(ctx, config, io).catch((error) => {
		fail(io, error);
	});
}
//#endregion
export { Config, MdStyler, Renderer, apply, assertRunnable, clipByWidth, collectExchanges, displayWidth, fmtTokens, inject, name, normalizeSessionId, relativeAge, sessionsInCwd, styleInlineMd, tailByWidth, titleFromEvents, toolCallLabel, wrapByWidth };

//# sourceMappingURL=index.js.map