/**
 * TUI startup: parse the flags the launcher forwards, then publish them as the
 * `tuiStartup` service the runner injects.
 *
 * @module dsh-plugin-tui/startup
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before this plugin can parse the command line. */
export const inject = ['cmdlineArgs']

/** Service key this plugin provides. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** One parsed invocation. */
export interface TuiStartupRequest {
  /** What the runner should do with the session. */
  action: 'list' | 'new' | 'resume-last' | 'resume-session'
  /** Optional first message; empty starts at the prompt. */
  task: string
  /** Explicit session id for `resume-session`; empty otherwise. */
  sessionId: string
  /** Auto-allow every tool approval request (the sandbox still applies). */
  autoApprove: boolean
  /** Permission preset to apply to the initial session; empty keeps the session's own. */
  permission: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Parsed TUI invocation published by this plugin. */
    tuiStartup: TuiStartupRequest
  }
}

function cliCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal UI: a REPL over a resumable coding-agent session.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'optional first message; multiple words are joined by spaces')
    .option('-n, --new', 'start a new session (this is the default)')
    .option('-r, --resume', 'resume the most recent tui session in the current working directory')
    .option('-s, --session <id>', 'resume a specific session id')
    .option('-w, --workdir <dir>', 'working directory for a NEW session (chdir before creating)')
    .option('-y, --auto-approve', 'auto-allow every tool approval request (the sandbox still applies)')
    .option('-p, --permission <preset>', 'apply a permission preset at startup (e.g. danger-full-access, workspace-write)')
    .option('-l, --list', "list this profile's sessions in the current working directory and exit")
    // This program owns the whole command line of whatever profile installs
    // the plugin. In the wrong profile that shows up as the host app's own
    // flags being rejected, so the error says who is parsing.
    .showHelpAfterError('(dsh-plugin-tui owns this command line; install it in its own profile)')
    .addHelpText('after', [
      '',
      'Examples:',
      '  dsh --profile tui                       # start at the prompt',
      '  dsh --profile tui "explain this file"   # send a first message, then stay interactive',
      '  dsh --profile tui --resume              # pick up the latest session here',
      '  dsh --profile tui --list                # list sessions in this directory',
      '  dsh --profile tui -p danger-full-access # start with full access (no sandbox, no prompts)',
      '  dsh --profile tui -p workspace-write -y # sandboxed, but approvals auto-allowed',
      '',
    ].join('\n'))
}

/** Parse argv and publish the request. */
export function apply(ctx: Context): void {
  const program = cliCommand()
  program.action(() => {
    const opts = program.opts<{
      new?: boolean
      resume?: boolean
      session?: string
      workdir?: string
      list?: boolean
      autoApprove?: boolean
      permission?: string
    }>()

    if (opts.list === true) {
      ctx.provide(TUI_STARTUP_SERVICE, {
        action: 'list',
        task: '',
        sessionId: '',
        autoApprove: false,
        permission: '',
      } satisfies TuiStartupRequest)
      return
    }

    // Unlike the one-shot runner, an empty task is fine: it means "start at
    // the prompt".
    const task = program.args.join(' ').trim()
    if (opts.session !== undefined && opts.resume === true) program.error('error: --session and --resume are mutually exclusive')
    if (opts.new === true && (opts.session !== undefined || opts.resume === true)) {
      program.error('error: --new cannot be combined with --session/--resume')
    }
    if (opts.workdir !== undefined && (opts.session !== undefined || opts.resume === true)) {
      program.error('error: --workdir applies to a new session only; a resumed session keeps its own cwd')
    }
    if (opts.workdir !== undefined) {
      const dir = resolve(opts.workdir)
      mkdirSync(dir, { recursive: true })
      process.chdir(dir)
    }

    ctx.provide(TUI_STARTUP_SERVICE, {
      action: opts.session !== undefined ? 'resume-session' : (opts.resume === true ? 'resume-last' : 'new'),
      task,
      sessionId: opts.session ?? '',
      autoApprove: opts.autoApprove === true,
      permission: opts.permission ?? '',
    } satisfies TuiStartupRequest)
  })
  // dsh-cmdline's types are pinned to its own (older) commander copy, and an
  // out-of-tree plugin necessarily brings its own — which is why parseCmdline
  // classifies commander errors structurally instead of by instanceof. The
  // shapes differ only in readonly-ness, so the cast is the whole fix.
  parseCmdline(ctx, program as unknown as Parameters<typeof parseCmdline>[1])
}
