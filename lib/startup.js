import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region src/startup.ts
/**
* TUI startup: parse the flags the launcher forwards, then publish them as the
* `tuiStartup` service the runner injects.
*
* @module dsh-plugin-tui/startup
*/
/** Cordis plugin name. */
const name = "tui-startup";
/** Services required before this plugin can parse the command line. */
const inject = ["cmdlineArgs"];
/** Service key this plugin provides. */
const TUI_STARTUP_SERVICE = "tuiStartup";
function cliCommand() {
	return new Command().name("dsh --profile tui").description("Interactive terminal UI: a REPL over a resumable coding-agent session.").helpOption("-h, --help", "show this help").argument("[task...]", "optional first message; multiple words are joined by spaces").option("-n, --new", "start a new session (this is the default)").option("-r, --resume", "resume the most recent tui session in the current working directory").option("-s, --session <id>", "resume a specific session id").option("-w, --workdir <dir>", "working directory for a NEW session (chdir before creating)").option("-y, --auto-approve", "auto-allow every tool approval request (the sandbox still applies)").option("-p, --permission <preset>", "apply a permission preset at startup (e.g. danger-full-access, workspace-write)").option("-l, --list", "list this profile's sessions in the current working directory and exit").showHelpAfterError("(dsh-plugin-tui owns this command line; install it in its own profile)").addHelpText("after", [
		"",
		"Examples:",
		"  dsh --profile tui                       # start at the prompt",
		"  dsh --profile tui \"explain this file\"   # send a first message, then stay interactive",
		"  dsh --profile tui --resume              # pick up the latest session here",
		"  dsh --profile tui --list                # list sessions in this directory",
		"  dsh --profile tui -p danger-full-access # start with full access (no sandbox, no prompts)",
		"  dsh --profile tui -p workspace-write -y # sandboxed, but approvals auto-allowed",
		""
	].join("\n"));
}
/** Parse argv and publish the request. */
function apply(ctx) {
	const program = cliCommand();
	program.action(() => {
		const opts = program.opts();
		if (opts.list === true) {
			ctx.provide(TUI_STARTUP_SERVICE, {
				action: "list",
				task: "",
				sessionId: "",
				autoApprove: false,
				permission: ""
			});
			return;
		}
		const task = program.args.join(" ").trim();
		if (opts.session !== void 0 && opts.resume === true) program.error("error: --session and --resume are mutually exclusive");
		if (opts.new === true && (opts.session !== void 0 || opts.resume === true)) program.error("error: --new cannot be combined with --session/--resume");
		if (opts.workdir !== void 0 && (opts.session !== void 0 || opts.resume === true)) program.error("error: --workdir applies to a new session only; a resumed session keeps its own cwd");
		if (opts.workdir !== void 0) {
			const dir = resolve(opts.workdir);
			mkdirSync(dir, { recursive: true });
			process.chdir(dir);
		}
		ctx.provide(TUI_STARTUP_SERVICE, {
			action: opts.session !== void 0 ? "resume-session" : opts.resume === true ? "resume-last" : "new",
			task,
			sessionId: opts.session ?? "",
			autoApprove: opts.autoApprove === true,
			permission: opts.permission ?? ""
		});
	});
	parseCmdline(ctx, program);
}
//#endregion
export { TUI_STARTUP_SERVICE, apply, inject, name };

//# sourceMappingURL=startup.js.map