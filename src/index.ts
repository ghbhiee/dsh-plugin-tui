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

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as readline from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-llm'
import type { TuiStartupRequest } from './startup.ts'
import { loadHostModules } from './host-modules.ts'

/** Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the REPL can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionPersistence', 'userQuestions']

/** Deployment-varying knobs. */
export interface Config {
  /** The parsed invocation, wired from `ctx.tuiStartup`. */
  request: TuiStartupRequest
  /** Value written to a session's `agentPreset`, which also scopes `--list`/`--resume`. */
  sessionTag: string
  /** How long to wait for a graceful exit before forcing one. */
  exitGraceMs: number
  /** Window for the second Ctrl-C that exits an idle REPL. */
  sigintExitWindowMs: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  request: z.object({
    action: z.string().default('new'),
    task: z.string().default(''),
    sessionId: z.string().default(''),
    autoApprove: z.boolean().default(false),
    permission: z.string().default(''),
  }) as unknown as z<TuiStartupRequest>,
  sessionTag: z.string().default('tui'),
  exitGraceMs: z.number().default(1500),
  sigintExitWindowMs: z.number().default(1500),
})

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'

/** Style inline markdown spans: `code`, **bold**, *italic*. Span-scoped codes, so surrounding state survives. */
export function styleInlineMd(text: string): string {
  return text.split(/(`[^`]+`)/).map(part => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return `\x1b[36m${part.slice(1, -1)}\x1b[39m`
    }
    return part
      .replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[22m')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s.,;:)!?])/g, '$1\x1b[3m$2\x1b[23m')
  }).join('')
}

/**
 * Line-at-a-time markdown styling with the one piece of cross-line state that
 * matters in a terminal: whether we are inside a fenced code block.
 */
export class MdStyler {
  private inFence = false

  /** Style one complete line (without its newline). */
  line(text: string): string {
    if (/^\s*(```|~~~)/.test(text)) {
      this.inFence = !this.inFence
      return `${DIM}${text}${RESET}`
    }
    if (this.inFence) return `${GREEN}${text}${RESET}`
    const heading = /^(#{1,6}) (.*)$/.exec(text)
    if (heading !== null) return `${BOLD}${text}${RESET}`
    if (/^\s*>/.test(text)) return `${DIM}${text}${RESET}`
    const bullet = /^(\s*)([-*+]|\d{1,3}\.) (.*)$/.exec(text)
    if (bullet !== null) {
      return `${bullet[1] ?? ''}${CYAN}${bullet[2] ?? ''}${RESET} ${styleInlineMd(bullet[3] ?? '')}`
    }
    return styleInlineMd(text)
  }

  /** Style a trailing fragment that never got its newline (end of turn). */
  fragment(text: string): string {
    return this.inFence ? `${GREEN}${text}${RESET}` : styleInlineMd(text)
  }
}

// Bold magenta »: clearly not a shell prompt. readline strips escapes when
// measuring prompt width, so the colors don't skew cursor math.
const PROMPT = '\x1b[1m\x1b[35m»\x1b[0m '

interface Io {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  exit: (code: number) => void
  graceMs: number
}

interface SessionHeaderLike {
  id: string
  cwd?: string
  createdAt: number
  agentPreset?: string
}

export function sessionsInCwd(headers: readonly SessionHeaderLike[], cwd: string, tag: string): SessionHeaderLike[] {
  return headers
    .filter(header => header.cwd === cwd && header.agentPreset === tag)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function normalizeSessionId(id: string): string {
  return id.startsWith('session-') ? id : `session-${id}`
}

/** Last `session/title` payload in a log, or undefined before one exists. */
export function titleFromEvents(events: readonly { type: string; data?: unknown }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/title') return (event.data as { title?: string }).title
  }
  return undefined
}

/** `3m ago` / `2h ago` / `5d ago` for session listings. */
export function relativeAge(thenMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** The slice of a ToolCallView the line renderer consumes. */
export interface ToolCallLine {
  card?: string
  title?: string
  description?: string
  kind?: string
}

/** `⏺` glyph color per tool-call category (presentation.d.ts's ToolCallKind). */
const TOOL_KIND_COLORS: Record<string, string> = {
  read: '\x1b[34m',
  edit: YELLOW,
  delete: '\x1b[31m',
  move: YELLOW,
  search: '\x1b[35m',
  execute: GREEN,
  fetch: '\x1b[34m',
  other: CYAN,
}

/** Approximate terminal display width: CJK and fullwidth glyphs count as 2 columns. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    width += (
      (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd)
    ) ? 2 : 1
  }
  return width
}

/** The leading portion of a string that fits within the given display columns, ellipsized. */
export function clipByWidth(text: string, cols: number): string {
  let width = 0
  let result = ''
  for (const ch of text) {
    const w = displayWidth(ch)
    if (width + w > cols - 1) return `${result}…`
    width += w
    result += ch
  }
  return result
}

/** Split text into rows no wider than the given display columns. */
export function wrapByWidth(text: string, cols: number): string[] {
  const rows: string[] = []
  let row = ''
  let width = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    if (width + w > cols) { rows.push(row); row = ch; width = w }
    else { row += ch; width += w }
  }
  if (row !== '') rows.push(row)
  return rows
}

/** The trailing portion of a string that fits within the given display columns. */
export function tailByWidth(text: string, cols: number): string {
  const chars = [...text]
  let width = 0
  let start = chars.length
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = displayWidth(chars[i] ?? '')
    if (width + w > cols) break
    width += w
    start = i
  }
  return chars.slice(start).join('')
}

/** Human-compact token count: 999 → '999', 12345 → '12.3k'. */
export function fmtTokens(count: number): string {
  if (count < 1000) return String(count)
  const thousands = count / 1000
  return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`
}

/** Compress a raw tool-arguments JSON string into one dim line. */
export function toolCallLabel(args: string, max = 100): string {
  const flat = args.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** One user message and everything the agent produced in response. */
export interface HistoryExchange {
  user: string
  parts: { kind: 'text' | 'tool' | 'error'; text: string; toolName?: string; args?: string }[]
}

/**
 * Fold a session log into user-visible exchanges for history replay: user
 * text, assistant text, tool calls, and turn errors — no reasoning, no
 * chunks. Non-user producers (goal, subagent splices) are skipped.
 */
export function collectExchanges(events: readonly { type: string; data?: unknown }[]): HistoryExchange[] {
  const exchanges: HistoryExchange[] = []
  let current: HistoryExchange | undefined
  for (const event of events) {
    if (event.type === 'user/message') {
      const data = event.data as { content?: { type: string; text?: string }[]; source?: { kind?: string } }
      if (data.source?.kind !== 'user') continue
      const text = (data.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (text.trim() === '') continue
      current = { user: text, parts: [] }
      exchanges.push(current)
    } else if (event.type === 'assistant/message' && current !== undefined) {
      const data = event.data as { message?: { content?: { type: string; text?: string }[] } }
      const text = (data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (text !== '') current.parts.push({ kind: 'text', text })
    } else if (event.type === 'tool/call' && current !== undefined) {
      const data = event.data as { name: string; arguments: string }
      current.parts.push({ kind: 'tool', text: '', toolName: data.name, args: data.arguments })
    } else if (event.type === 'turn/end' && current !== undefined) {
      const reason = (event.data as { reason?: { kind?: string; error?: { code?: string; message?: string } } }).reason
      if (reason?.kind === 'error') {
        current.parts.push({ kind: 'error', text: `${reason.error?.code ?? 'error'}: ${reason.error?.message ?? ''}` })
      }
    }
  }
  return exchanges
}

/**
 * Read a persisted session's title without resuming it: `inspect` yields the
 * immutable log, and the last `session/title` event wins. Every miss —
 * backend without inspect, absent session, torn log — is just "no title".
 */
async function coldTitle(persistence: unknown, id: string): Promise<string | undefined> {
  try {
    const inspect = (persistence as {
      inspect?: (id: string) => Promise<{ events?: readonly { type: string; data?: unknown }[] } | undefined>
    }).inspect
    if (inspect === undefined) return undefined
    const view = await inspect.call(persistence, id)
    if (process.env.TUI_DEBUG === '1') {
      const { appendFileSync } = await import('node:fs')
      appendFileSync('/tmp/tui-debug.log', `inspect ${id}: keys=${JSON.stringify(Object.keys(view ?? {}))} events=${String((view as { events?: unknown[] })?.events?.length)}\n`)
    }
    return titleFromEvents(view?.events ?? [])
  } catch (error) {
    if (process.env.TUI_DEBUG === '1') {
      const { appendFileSync } = await import('node:fs')
      appendFileSync('/tmp/tui-debug.log', `inspect ${id} THREW: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    return undefined
  }
}

/** Ask for a graceful shutdown, with a hard fallback so the process always exits. */
function exitNow(io: Io, code: number): void {
  io.exit(code)
  setTimeout(() => { process.exit(code) }, io.graceMs)
}

function fail(io: Io, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  exitNow(io, 1)
}

/** Reject a configuration that cannot do anything sensible. */
export function assertRunnable(config: Config): void {
  if (config.sessionTag.trim() === '') {
    throw new Error('tui-runner: sessionTag must not be empty; it is the label --list and --resume scope by')
  }
  if (!Number.isFinite(config.exitGraceMs) || config.exitGraceMs < 0) {
    throw new Error(`tui-runner: exitGraceMs must be a non-negative number, got ${String(config.exitGraceMs)}`)
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const SPINNER_INTERVAL_MS = 120
const DELTA_FLUSH_MS = 16
const DELTA_FLUSH_CHARS = 512

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
export class Renderer {
  private midLine = false
  private lastKind: 'text' | 'reasoning' | 'other' = 'other'
  private pending = ''
  private pendingKind: 'text' | 'reasoning' | undefined = undefined
  private readonly md = new MdStyler()
  private lineBuf = ''
  private lineEmitted = 0
  private flushTimer: NodeJS.Timeout | undefined = undefined
  private spinnerTimer: NodeJS.Timeout | undefined = undefined
  private spinnerVisible = false
  private spinnerFrame = 0
  private spinnerRows = 1
  private lineIdleTimer: NodeJS.Timeout | undefined = undefined
  private reasoningVisible: boolean
  private thinkingTail = ''
  private turnDetail = ''

  constructor(private readonly out: NodeJS.WritableStream, opts?: { reasoningVisible?: boolean }) {
    this.reasoningVisible = opts?.reasoningVisible ?? false
  }

  /** Whether the thinking stream currently prints in full. */
  get thinkingShown(): boolean {
    return this.reasoningVisible
  }

  private statusActive = false

  /**
   * Reserve the terminal's last row as a fixed status bar by shrinking the
   * scroll region to the rows above it (DECSTBM). Everything the renderer
   * already does happens inside the region, so ordinary output scrolls while
   * the bar stays put. Call again (fresh=false) after a resize to re-fit.
   */
  enableStatusBar(fresh = true): void {
    const rows = (this.out as { rows?: number }).rows
    if (rows === undefined || rows < 4) return
    // A newline first: launched from a shell whose cursor sits on the
    // terminal's LAST row, the region would otherwise be set with the cursor
    // outside it — and every later line would pin to the bar row instead of
    // scrolling. DECSTBM then homes the cursor, so place it explicitly on
    // the region's bottom row.
    if (fresh) this.out.write('\n')
    // Two reserved rows: a rule line above the status text.
    this.out.write(`\x1b[1;${rows - 2}r\x1b[${rows - 2};1H`)
    this.statusActive = true
  }

  /** Redraw the status bar content (clipped and padded to the full width). */
  setStatus(text: string): void {
    if (!this.statusActive) return
    const size = this.out as { rows?: number; columns?: number }
    const rows = size.rows ?? 24
    const cols = size.columns ?? 80
    const clipped = clipByWidth(text, cols - 2)
    // A dim rule caps the bar; the status itself is plain gray text (no
    // reverse-video background — it blended into the input rule).
    const rule = '─'.repeat(Math.max(1, cols - 1))
    this.out.write(`\x1b7\x1b[${rows - 1};1H\x1b[2K\x1b[2m${rule}\x1b[0m\x1b[${rows};1H\x1b[2K\x1b[90m ${clipped}\x1b[0m\x1b8`)
  }

  /** Restore the full scroll region and blank the bar (leave/exit paths). */
  disableStatusBar(): void {
    if (!this.statusActive) return
    const rows = (this.out as { rows?: number }).rows ?? 24
    this.out.write(`\x1b7\x1b[r\x1b[${rows - 1};1H\x1b[2K\x1b[${rows};1H\x1b[2K\x1b8`)
    this.statusActive = false
  }

  /** Flip between the one-line thinking tail and the full dim stream. */
  toggleReasoning(): void {
    this.reasoningVisible = !this.reasoningVisible
    if (this.reasoningVisible) {
      this.note('(thinking shown — ctrl+o to hide)')
      // Replay what was collapsed so far, so the toggle has an immediate,
      // visible effect even when the model is mid-thought.
      if (this.turnDetail !== '') {
        this.out.write(`${DIM}${this.turnDetail}${RESET}\n`)
        this.lastKind = 'reasoning'
        this.midLine = false
      }
      this.turnDetail = ''
      this.thinkingTail = ''
    } else {
      this.note('(thinking hidden — ctrl+o to show)')
    }
  }

  /** Erase a drawn spinner block (up to 3 rows) so real output never lands after it. */
  private eraseSpinner(): void {
    if (!this.spinnerVisible) return
    this.out.write('\r\x1b[2K')
    for (let i = 1; i < this.spinnerRows; i++) this.out.write('\x1b[1A\x1b[2K')
    this.spinnerVisible = false
    this.spinnerRows = 1
  }

  /**
   * Animate while a turn runs; draws only on an otherwise-quiet clean line.
   * With thinking collapsed, the spinner line doubles as the live one-line
   * tail of the reasoning stream.
   */
  startSpinner(): void {
    if (this.spinnerTimer !== undefined) return
    this.spinnerTimer = setInterval(() => {
      if (this.midLine || this.pending !== '') return
      this.eraseSpinner()
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? ''
      // Budget in DISPLAY columns, not characters: a CJK tail counted by
      // .length wraps the line, and the erase then misses the wrapped rows.
      // Up to three rows of the freshest thinking, wrapped by display width.
      const width = (this.out as { columns?: number }).columns ?? 80
      const budget = Math.max(20, width - 4)
      const rows = this.thinkingTail === '' ? ['…'] : wrapByWidth(this.thinkingTail, budget).slice(-3)
      const block = rows
        .map((row, i) => (i === 0 ? `${DIM}${frame} ${row}${RESET}` : `${DIM}  ${row}${RESET}`))
        .join('\n')
      this.out.write(block)
      this.spinnerRows = rows.length
      this.spinnerVisible = true
      this.spinnerFrame += 1
    }, SPINNER_INTERVAL_MS)
    this.spinnerTimer.unref?.()
  }

  stopSpinner(): void {
    if (this.spinnerTimer !== undefined) { clearInterval(this.spinnerTimer); this.spinnerTimer = undefined }
    this.eraseSpinner()
    this.thinkingTail = ''
    // turnDetail deliberately survives the turn: a ctrl+o right after the
    // answer reveals what the JUST-FINISHED turn did. The next exchange
    // clears it, so the toggle never digs into older turns.
  }

  /** Forget the previous exchange's detail; called as a new exchange starts. */
  clearTurnDetail(): void {
    this.turnDetail = ''
  }

  /** Write out any batched deltas. Structural lines call this first. */
  flush(): void {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    if (this.pendingKind === undefined || this.pending === '') { this.pendingKind = undefined; return }
    const kind = this.pendingKind
    const text = this.pending
    this.pending = ''
    this.pendingKind = undefined
    // Collapsed thinking never reaches the transcript: it only refreshes the
    // one-line tail the spinner shows, so it must not disturb line state.
    if (kind === 'reasoning' && !this.reasoningVisible) {
      this.thinkingTail = `${this.thinkingTail}${text}`.replace(/\s+/g, ' ').slice(-600)
      this.turnDetail = `${this.turnDetail}${text}`.slice(-8000)
      return
    }
    this.eraseSpinner()
    if (this.lastKind !== 'other' && this.lastKind !== kind) this.breakLine()
    this.lastKind = kind
    if (kind === 'reasoning') {
      this.out.write(`${DIM}${text}${RESET}`)
      this.midLine = !text.endsWith('\n')
    } else {
      this.emitText(text)
    }
  }

  private static readonly RAW_LINE_THRESHOLD = 200

  /**
   * Answer text is held until its line completes, then styled as markdown and
   * written whole — retroactive re-styling of a partially printed line would
   * need erase tricks that corrupt wrapped lines. A very long single-line run
   * escapes to raw streaming instead of sitting invisible in the buffer (its
   * later completion then skips styling: the head is already on screen).
   */
  private emitText(text: string): void {
    this.lineBuf += text
    for (;;) {
      const nl = this.lineBuf.indexOf('\n')
      if (nl === -1) break
      const line = this.lineBuf.slice(0, nl)
      this.lineBuf = this.lineBuf.slice(nl + 1)
      if (this.lineEmitted > 0) {
        this.out.write(`${line.slice(this.lineEmitted)}\n`)
        this.lineEmitted = 0
      } else {
        this.out.write(`${this.md.line(line)}\n`)
      }
      this.midLine = false
    }
    const unwritten = this.lineBuf.length - this.lineEmitted
    if (unwritten > 0 && (this.lineEmitted > 0 || this.lineBuf.length > Renderer.RAW_LINE_THRESHOLD)) {
      this.out.write(this.lineBuf.slice(this.lineEmitted))
      this.lineEmitted = this.lineBuf.length
      this.midLine = true
    } else if (this.lineBuf.length > this.lineEmitted) {
      // A buffered partial line must not sit invisible while the stream stalls
      // (perceived as slowness): stream it raw after a short quiet gap.
      if (this.lineIdleTimer !== undefined) clearTimeout(this.lineIdleTimer)
      this.lineIdleTimer = setTimeout(() => {
        this.lineIdleTimer = undefined
        if (this.lineBuf.length > this.lineEmitted) {
          this.eraseSpinner()
          this.out.write(this.lineBuf.slice(this.lineEmitted))
          this.lineEmitted = this.lineBuf.length
          this.midLine = true
        }
      }, 250)
      this.lineIdleTimer.unref?.()
    }
  }

  /** Put any buffered partial line on screen (inline-styled); turn boundaries call this. */
  private dumpLine(): void {
    if (this.lineIdleTimer !== undefined) { clearTimeout(this.lineIdleTimer); this.lineIdleTimer = undefined }
    if (this.lineBuf === '') { this.lineEmitted = 0; return }
    const rest = this.lineBuf.slice(this.lineEmitted)
    if (rest !== '') {
      this.eraseSpinner()
      this.out.write(this.lineEmitted > 0 ? rest : this.md.fragment(rest))
    }
    this.midLine = true
    this.lineBuf = ''
    this.lineEmitted = 0
  }

  private queueDelta(kind: 'text' | 'reasoning', text: string): void {
    if (text === '') return
    if (this.pendingKind !== undefined && this.pendingKind !== kind) this.flush()
    this.pendingKind = kind
    this.pending += text
    if (this.pending.length >= DELTA_FLUSH_CHARS) { this.flush(); return }
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush() }, DELTA_FLUSH_MS)
      this.flushTimer.unref?.()
    }
  }

  /** Ensure the cursor is at column 0 before a structural line. */
  breakLine(): void {
    this.flush()
    this.dumpLine()
    this.eraseSpinner()
    if (this.midLine) { this.out.write('\n'); this.midLine = false }
    this.lastKind = 'other'
  }

  textDelta(text: string): void {
    this.queueDelta('text', text)
  }

  reasoningDelta(text: string): void {
    this.queueDelta('reasoning', text)
  }

  /**
   * A tool call renders as ONE summary line naming its task — never the full
   * command or code (a heredoc script used to land verbatim in the
   * transcript). The full input goes to the per-turn detail buffer instead,
   * where ctrl+o reveals it alongside the thinking stream.
   */
  toolCall(name_: string, args: string, view?: ToolCallLine): void {
    this.breakLine()
    const kind = view?.card === 'terminal' ? 'execute' : view?.card === 'diff' ? 'edit' : view?.kind ?? 'other'
    const glyph = `${TOOL_KIND_COLORS[kind] ?? CYAN}⏺${RESET}`
    if (view?.title !== undefined) {
      const lines = view.title.split('\n')
      const first = lines[0] ?? ''
      const extra = lines.length - 1
      const more = extra > 0 ? ` ${DIM}(+${extra} lines)${RESET}` : ''
      if (view.card === 'terminal') {
        // The task summary is the card's description; the command itself is
        // detail. Without a description, the clipped first line stands in.
        const label = view.description ?? `$ ${clipByWidth(first, 70)}`
        this.out.write(`${glyph} ${BOLD}${label}${RESET}${more}\n`)
        this.detailBlock(name_, view.title)
      } else {
        const description = view.description === undefined ? '' : ` ${DIM}— ${view.description}${RESET}`
        this.out.write(`${glyph} ${BOLD}${clipByWidth(first, 70)}${RESET}${description}${more}\n`)
        if (extra > 0) this.detailBlock(name_, view.title)
      }
    } else {
      this.out.write(`${glyph} ${name_} ${DIM}${toolCallLabel(args, 80)}${RESET}\n`)
      if (args.length > 80) this.detailBlock(name_, args)
    }
  }

  /**
   * Route a tool's full input to the turn's detail stream: printed dim when
   * thinking is shown, otherwise buffered for a later ctrl+o — which always
   * reveals only the CURRENT turn (the buffer clears when the turn settles).
   */
  private detailBlock(tool: string, body: string): void {
    const block = `── ${tool} ──\n${body}\n`
    if (this.reasoningVisible) {
      this.out.write(`${DIM}${block}${RESET}`)
      this.midLine = false
      this.lastKind = 'other'
    } else {
      this.turnDetail = `${this.turnDetail}${block}`.slice(-8000)
    }
  }

  toolError(code: string): void {
    this.breakLine()
    this.out.write(`${YELLOW}  ⚠ ${code}${RESET}\n`)
  }

  turnError(code: string, message: string): void {
    this.breakLine()
    this.out.write(`${YELLOW}✖ ${code}: ${message}${RESET}\n`)
  }

  /** Latest-wins todo snapshot as a compact checklist. */
  todoList(todos: readonly { content: string; status: string }[]): void {
    this.breakLine()
    for (const todo of todos) {
      const glyph = todo.status === 'completed'
        ? `${GREEN}☑${RESET}`
        : todo.status === 'in_progress' ? `${YELLOW}◐${RESET}` : `${DIM}☐${RESET}`
      const body = todo.status === 'completed' ? `${DIM}${todo.content}${RESET}` : todo.content
      this.out.write(`  ${glyph} ${body}\n`)
    }
  }

  /** One dim per-exchange accounting line. */
  usageLine(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number }): void {
    this.breakLine()
    const parts = [`${fmtTokens(usage.inputTokens)} in`, `${fmtTokens(usage.outputTokens)} out`]
    if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) parts.push(`${fmtTokens(usage.cacheReadTokens)} cached`)
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) parts.push(`${fmtTokens(usage.reasoningTokens)} reasoning`)
    this.out.write(`${DIM}↳ ${parts.join(' · ')}${RESET}\n`)
  }

  note(text: string): void {
    this.breakLine()
    this.out.write(`${DIM}${text}${RESET}\n`)
  }
}

async function run(ctx: Context, config: Config, io: Io): Promise<void> {
  const request = config.request
  // Deliberately NOT `await ctx.get('loader')?.await()`: that waits for every
  // plugin — including MCP servers doing OAuth handshakes — and measured 5s+
  // of the 5.4s boot. The injected services are ready by contract; late tool
  // registrations (MCP discovery) simply join the toolset once connected.
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined || sessions === undefined || persistence === undefined || defaultModel === undefined) return

  const cwd = process.cwd()

  if (request.action === 'list') {
    const mine = sessionsInCwd(await persistence.list() as SessionHeaderLike[], cwd, config.sessionTag)
    if (mine.length === 0) io.stdout.write(`(no ${config.sessionTag} sessions for ${cwd})\n`)
    else {
      for (const header of mine) {
        const title = await coldTitle(persistence, header.id) ?? ''
        io.stdout.write(`${header.id}\t${new Date(header.createdAt).toISOString()}\t${title}\n`)
      }
    }
    exitNow(io, 0)
    return
  }

  const { installModelSelection, createUserMessage, SessionId } = await loadHostModules(ctx.baseUrl)
  // One mutable selection shared by every agent this REPL creates: prompt
  // assembly snapshots it per step, so /model and /effort take effect from the
  // next step — even mid-turn — without touching the machine-wide default.
  const selectionRef: Parameters<typeof installModelSelection>[1] = {
    current: defaultModel.currentSelection(),
    assembled: undefined,
  }
  type LiveSelection = NonNullable<typeof selectionRef.current>
  const currentSelection = (): LiveSelection => selectionRef.current ?? defaultModel.currentSelection()

  // The tui profile remembers its own model choice (tui-model.json beside the
  // profile) instead of writing the machine-wide default — other surfaces
  // keep their configuration. `/model default` clears it.
  const profileDir = ((): string | undefined => {
    try {
      return ctx.baseUrl === undefined ? undefined : fileURLToPath(new URL('.', ctx.baseUrl))
    } catch {
      return undefined
    }
  })()
  const modelPrefPath = profileDir === undefined ? undefined : join(profileDir, 'tui-model.json')
  if (modelPrefPath !== undefined) {
    try {
      const pref = JSON.parse(readFileSync(modelPrefPath, 'utf8')) as {
        provider?: string
        model?: string
        reasoningEffort?: string
      }
      if (typeof pref.provider === 'string' && typeof pref.model === 'string') {
        selectionRef.current = {
          provider: pref.provider,
          model: pref.model,
          ...(typeof pref.reasoningEffort === 'string'
            ? { reasoningEffort: pref.reasoningEffort as NonNullable<LiveSelection['reasoningEffort']> }
            : {}),
        }
      }
    } catch {
      // No preference stored (or unreadable): the machine default stands.
    }
  }
  const setSelection = (next: LiveSelection): void => {
    selectionRef.current = next
    if (modelPrefPath === undefined) return
    try {
      writeFileSync(modelPrefPath, `${JSON.stringify(next)}\n`)
    } catch {
      // Remembering the choice is a convenience; never let it break the REPL.
    }
  }
  const clearSelectionPref = (): void => {
    selectionRef.current = defaultModel.currentSelection()
    if (modelPrefPath === undefined) return
    try {
      rmSync(modelPrefPath, { force: true })
    } catch {
      // Same: best effort only.
    }
  }
  const setup = (agentCtx: Context): void => { installModelSelection(agentCtx, selectionRef) }
  const agentOptions = (): { provider: string; model: string } => ({
    provider: currentSelection().provider,
    model: currentSelection().model,
  })

  let handle: Awaited<ReturnType<typeof agents.create>> | Awaited<ReturnType<typeof agents.resume>>
  let sessionId: string
  if (request.action === 'new') {
    sessionId = `session-${randomUUID()}`
    handle = await agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd, agentPreset: config.sessionTag },
      agentOptions: agentOptions(),
      setup,
    })
  } else {
    const resolved = request.action === 'resume-session'
      ? normalizeSessionId(request.sessionId)
      : sessionsInCwd(await persistence.list() as SessionHeaderLike[], cwd, config.sessionTag)[0]?.id
    if (resolved === undefined) {
      io.stderr.write(`dsh: no ${config.sessionTag} session to resume in ${cwd}\n`)
      exitNow(io, 1)
      return
    }
    sessionId = resolved
    handle = await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: agentOptions(), setup })
  }

  let agent = handle.agent
  io.stderr.write(`session: ${sessionId}\n`)
  // A session killed mid-turn resumes with that turn still open, and the
  // agent loop would happily keep running it — but a resume is a request to
  // SEE the conversation, not to relaunch it. Cancel before waiting.
  let resumedMidTurn = false
  if (request.action !== 'new' && agent.status === 'running') {
    resumedMidTurn = true
    agent.cancel({ kind: 'user' })
  }
  await agent.whenIdle()

  const render = new Renderer(io.stdout)

  // Per-exchange token accounting, summed across the exchange's steps (each
  // step is a billed request). Reset before each followup, printed at idle.
  const exchangeUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, steps: 0 }
  const resetUsage = (): void => {
    exchangeUsage.inputTokens = 0
    exchangeUsage.outputTokens = 0
    exchangeUsage.cacheReadTokens = 0
    exchangeUsage.reasoningTokens = 0
    exchangeUsage.steps = 0
  }

  // Ask the tool itself how a call renders (same view model the web cards
  // use). Presenter misses and throws soft-fall to the raw line.
  const toolView = (toolName: string, rawArgs: string): ToolCallLine | undefined => {
    try {
      return ctx.get('tools')?.get(toolName)?.presentCall?.(JSON.parse(rawArgs)) as ToolCallLine | undefined
    } catch {
      return undefined
    }
  }

  // Post-commit session facts are the only stream: token deltas, tool calls,
  // and turn endings all arrive here. The listener must never append back
  // into the session (synchronous re-entry is rejected at the source).
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    const typed = event as { type: string; data?: unknown }
    if (typed.type === 'assistant/chunk') {
      const { chunk } = typed.data as { chunk: { type: string; text?: string } }
      if (chunk.type === 'text-delta') render.textDelta(chunk.text ?? '')
      else if (chunk.type === 'reasoning-delta') render.reasoningDelta(chunk.text ?? '')
    } else if (typed.type === 'tool/call') {
      const data = typed.data as { name: string; arguments: string }
      render.toolCall(data.name, data.arguments, toolView(data.name, data.arguments))
    } else if (typed.type === 'tool/result') {
      const data = typed.data as { error?: { code: string } }
      if (data.error !== undefined) render.toolError(data.error.code)
    } else if (typed.type === 'turn/end') {
      const reason = (typed.data as { reason?: { kind?: string; error?: { code?: string; message?: string } } }).reason
      if (reason?.kind === 'error') render.turnError(reason.error?.code ?? 'error', reason.error?.message ?? '')
    } else if (typed.type === 'todo/write') {
      const todos = (typed.data as { todos?: { content: string; status: string }[] }).todos
      if (todos !== undefined && todos.length > 0) render.todoList(todos)
    } else if (typed.type === 'assistant/message') {
      const usage = (typed.data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number } }).usage
      if (usage !== undefined) {
        exchangeUsage.inputTokens += usage.inputTokens ?? 0
        exchangeUsage.outputTokens += usage.outputTokens ?? 0
        exchangeUsage.cacheReadTokens += usage.cacheReadTokens ?? 0
        exchangeUsage.reasoningTokens += usage.reasoningTokens ?? 0
        exchangeUsage.steps += 1
      }
    }
  })

  // Prompt history survives across runs in the profile directory. Every miss
  // (no baseUrl, unreadable file) just means an empty history.
  const historyPath = profileDir === undefined ? undefined : join(profileDir, 'tui-history.txt')
  let initialHistory: string[] = []
  if (historyPath !== undefined) {
    try {
      initialHistory = readFileSync(historyPath, 'utf8').split('\n').filter(line => line !== '').slice(0, 200)
    } catch {
      initialHistory = []
    }
  }
  const saveHistory = (entries: readonly string[]): void => {
    if (historyPath === undefined) return
    try {
      writeFileSync(historyPath, `${entries.slice(0, 200).join('\n')}\n`)
    } catch {
      // History is a convenience; never let it break the REPL.
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    history: initialHistory,
    historySize: 200,
  })

  let historyTimer: NodeJS.Timeout | undefined
  ;(rl as unknown as { on(event: 'history', cb: (entries: string[]) => void): void }).on('history', entries => {
    if (historyTimer !== undefined) clearTimeout(historyTimer)
    historyTimer = setTimeout(() => { saveHistory(entries) }, 500)
    historyTimer.unref?.()
  })

  // ctrl+o toggles the full thinking stream (default: a one-line live tail on
  // the spinner). The keypress feed rides the same raw-mode stream readline
  // already owns, so this adds a listener, not a competing reader.
  if (process.stdin.isTTY === true) {
    readline.emitKeypressEvents(process.stdin, rl)
    process.stdin.on('keypress', (_str: string | undefined, key: { ctrl?: boolean; name?: string } | undefined) => {
      if (key?.ctrl === true && key.name === 'o') render.toggleReasoning()
      setImmediate(() => { repaintStatus() })
    })
  }

  let running = false
  let closing = false
  let lastSigint = 0
  // readline's prompt repaint clears to end-of-screen, wiping the status bar
  // below the scroll region — every prompt/keystroke repaint re-draws it.
  let repaintStatus: () => void = () => {}

  const leave = (code: number): void => {
    if (closing) return
    closing = true
    render.stopSpinner()
    render.disableStatusBar()
    saveHistory((rl as unknown as { history?: string[] }).history ?? [])
    rl.close()
    void sessions.flush(agent.session)
      .catch(() => undefined)
      .then(() => { exitNow(io, code) })
  }

  rl.on('close', () => {
    // Ctrl-D at the prompt (or the input stream ending) leaves gracefully.
    if (!closing) leave(0)
  })

  // In raw mode Ctrl-C is a keystroke readline surfaces here; no process
  // SIGINT is ever raised from the keyboard (verified against the launcher).
  rl.on('SIGINT', () => {
    if (running) {
      agent.cancel({ kind: 'user' })
      render.note('(turn cancelled)')
      return
    }
    const now = Date.now()
    if (now - lastSigint < config.sigintExitWindowMs) { leave(130); return }
    lastSigint = now
    render.note('(^C again to exit, or press Enter for a prompt)')
  })

  const question = (): Promise<string> => new Promise(resolve => {
    // A dim rule above the input row (with the status bar right below) frames
    // where typing goes.
    const cols = (process.stdout as { columns?: number }).columns ?? 80
    io.stdout.write(`${DIM}${'─'.repeat(Math.max(20, Math.min(cols - 1, 100)))}${RESET}\n`)
    rl.question(PROMPT, resolve)
    repaintStatus()
  })

  const askLine = (prompt: string, signal?: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) { reject(new Error('question aborted')); return }
      const onAbort = (): void => { reject(new Error('question aborted')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      rl.question(prompt, answer => {
        signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      })
      repaintStatus()
    })

  // Channel-neutral approval seam: without an answerer every gated tool call
  // fails closed, so the REPL is the profile's answerer of record. In `auto`
  // mode every request is allowed with a one-line audit note instead of a
  // prompt — the sandbox still applies, only the escalation stops asking.
  let approvalMode: 'ask' | 'auto' = request.autoApprove ? 'auto' : 'ask'
  let approvalHintShown = false
  ctx.on('approval/request', (approval, next) => {
    if (approval.agent !== agent) return next()
    const reason = approval.reason === undefined ? '' : ` ${DIM}(${approval.reason})${RESET}`
    if (approvalMode === 'auto') {
      render.note(`⚠ auto-approved: ${approval.toolName}${approval.reason === undefined ? '' : ` — ${clipByWidth(approval.reason, 70)}`}`)
      return Promise.resolve('allowed-once' as const)
    }
    render.breakLine()
    render.stopSpinner()
    return new Promise(resolve => {
      rl.question(`${YELLOW}⚠ allow tool "${approval.toolName}"?${RESET}${reason} [y/N] `, answer => {
        if (running) render.startSpinner()
        repaintStatus()
        if (!approvalHintShown) {
          approvalHintShown = true
          render.note('(tip: /approvals auto allows everything for this session; dsh --profile tui -y does it from launch)')
        }
        resolve(/^y(es)?$/i.test(answer.trim()) ? 'allowed-once' : 'rejected')
      })
    })
  })

  // The other channel-neutral seam: ask_user_question and plan review both
  // block on a human answerer. 0.1.1 exposes a single-provider registration;
  // 0.1.2 replaced it with an answerer waterfall ('user-questions/request',
  // mirroring approval/request) — support both so one build spans the drift.
  const answerQuestions = async (request: {
    questions: readonly {
      id: string
      question: string
      detail?: string
      header?: string
      options?: readonly { label: string; description?: string }[]
      multiSelect?: boolean
    }[]
    signal?: AbortSignal
  }): Promise<{ answers: AskUserQuestionAnswerItem[] }> => {
        render.stopSpinner()
        const answers: AskUserQuestionAnswerItem[] = []
        for (const item of request.questions) {
          render.breakLine()
          const head = item.header === undefined ? '' : `[${item.header}] `
          io.stdout.write(`${YELLOW}⁇ ${head}${item.question}${RESET}\n`)
          if (item.detail !== undefined && item.detail !== '') io.stdout.write(`${DIM}${item.detail}${RESET}\n`)
          const options = item.options ?? []
          options.forEach((option, index) => {
            const description = option.description === undefined ? '' : ` ${DIM}— ${option.description}${RESET}`
            io.stdout.write(`  ${index + 1}) ${option.label}${description}\n`)
          })
          const hint = options.length === 0
            ? 'answer'
            : item.multiSelect === true
              ? `pick 1-${options.length} (comma-separated) or type an answer`
              : `pick 1-${options.length} or type an answer`
          const raw = (await askLine(`${hint}: `, request.signal)).trim()
          const picks = raw.split(/[\s,]+/).filter(part => part !== '')
          const indices = picks.map(part => Number.parseInt(part, 10))
          const numeric = options.length > 0 && picks.length > 0
            && indices.every(value => Number.isInteger(value) && value >= 1 && value <= options.length)
          if (numeric) {
            const chosen = (item.multiSelect === true ? indices : indices.slice(0, 1))
              .map(value => options[value - 1]?.label ?? '')
            answers.push({ id: item.id, selected: chosen })
          } else {
            answers.push({ id: item.id, selected: [], ...(raw === '' ? {} : { custom: raw }) })
          }
        }
        if (running) render.startSpinner()
        return { answers }
  }
  const questionService = ctx.get('userQuestions') as
    | { registerProvider?: (provider: { ask: typeof answerQuestions }) => unknown }
    | undefined
  if (questionService !== undefined && typeof questionService.registerProvider === 'function') {
    questionService.registerProvider({ ask: answerQuestions })
  } else {
    ;(ctx as unknown as {
      on: (event: string, handler: (request: Parameters<typeof answerQuestions>[0] & { agent?: unknown }, next: () => unknown) => unknown) => void
    }).on('user-questions/request', (request, next) => {
      if (request.agent !== undefined && request.agent !== agent) return next()
      return answerQuestions(request)
    })
  }

  // Signature drift: 0.1.1-rc.2 ships execute(agent, line, images, signal);
  // the published rc.6 types (and newer source) drop the images parameter.
  // Dispatch on arity so both runtimes get their signal in the right slot.
  const execCommand = async (line: string): Promise<Awaited<ReturnType<NonNullable<ReturnType<typeof ctx.get<'commands'>>>['execute']>>> => {
    const commands = ctx.get('commands')
    if (commands === undefined) return undefined
    const signal = new AbortController().signal
    const execute = commands.execute.bind(commands)
    return commands.execute.length >= 4
      ? await (execute as unknown as (
          agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal,
        ) => ReturnType<typeof execute>)(agent, line, [], signal)
      : await execute(agent, line, signal)
  }

  if (process.stdout.isTTY === true) {
    render.enableStatusBar()
  } else {
    const bannerSel = currentSelection()
    const bannerEffort = bannerSel.reasoningEffort === undefined ? '' : ` (${String(bannerSel.reasoningEffort)})`
    render.note(`${bannerSel.provider}/${bannerSel.model}${bannerEffort} · ${cwd} · /exit to quit · ctrl+o thinking`)
  }

  // ---- in-REPL session management -----------------------------------------

  let lastListing: SessionHeaderLike[] = []

  const listMine = async (): Promise<SessionHeaderLike[]> => {
    lastListing = sessionsInCwd(await persistence.list() as SessionHeaderLike[], cwd, config.sessionTag)
    return lastListing
  }

  const liveTitle = (): string | undefined => ctx.get('sessionTitle')?.get(agent.session)?.title

  const printSessions = async (): Promise<void> => {
    const mine = await listMine()
    const lines: string[] = []
    // A just-created session materializes only on its first append, so until
    // then it is absent from the persisted list; show it unnumbered.
    if (!mine.some(header => header.id === sessionId)) {
      lines.push(`*  ${liveTitle() ?? '(new session)'} · ${sessionId.replace('session-', '').slice(0, 8)}`)
    }
    if (mine.length === 0 && lines.length === 0) { render.note(`(no ${config.sessionTag} sessions for ${cwd})`); return }
    for (const [index, header] of mine.entries()) {
      const marker = header.id === sessionId ? '*' : ' '
      const title = (header.id === sessionId ? liveTitle() : undefined)
        ?? await coldTitle(persistence, header.id)
        ?? '(untitled)'
      lines.push(`${marker}${index + 1}) ${title} · ${relativeAge(header.createdAt, Date.now())} · ${header.id.replace('session-', '').slice(0, 8)}`)
    }
    render.note(lines.join('\n'))
  }

  const switchTo = async (target: { kind: 'new' } | { kind: 'resume'; id: string }): Promise<void> => {
    const previous = handle
    try {
      if (target.kind === 'new') {
        const freshId = `session-${randomUUID()}`
        const fresh = await agents.create({
          sessionId: SessionId(freshId),
          meta: { cwd, agentPreset: config.sessionTag },
          agentOptions: agentOptions(),
          setup,
        })
        handle = fresh
        agent = fresh.agent
        sessionId = freshId
      } else {
        const fresh = await agents.resume({ resumeSessionId: SessionId(target.id), agentOptions: agentOptions(), setup })
        handle = fresh
        agent = fresh.agent
        sessionId = target.id
      }
    } catch (error) {
      render.turnError('session', error instanceof Error ? error.message : String(error))
      return
    }
    // Viewing history must never relaunch it: a session killed mid-turn
    // resumes with the turn open and the loop running — cancel first.
    if (target.kind === 'resume' && agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      render.note('(the resumed session had an unfinished turn — cancelled)')
    }
    await agent.whenIdle()
    io.stderr.write(`session: ${sessionId}\n`)
    render.note(`switched to ${liveTitle() ?? sessionId}`)
    if (target.kind === 'resume') renderHistoryTail()
    else historyShownFrom = 0
    // Only after the new session is live: flush and release the old one, so a
    // failed switch never strands the REPL without an agent.
    try {
      await sessions.flush(previous.agent.session)
      await previous.dispose()
    } catch {
      // The old handle may already be gone; the switch itself succeeded.
    }
  }

  const resolveTarget = async (arg: string): Promise<string | undefined> => {
    const index = Number.parseInt(arg, 10)
    if (Number.isInteger(index) && String(index) === arg && index >= 1) {
      const mine = lastListing.length > 0 ? lastListing : await listMine()
      return mine[index - 1]?.id
    }
    const mine = await listMine()
    const normalized = normalizeSessionId(arg)
    const exact = mine.find(header => header.id === normalized)
    if (exact !== undefined) return exact.id
    const byPrefix = mine.filter(header => header.id.replace('session-', '').startsWith(arg))
    return byPrefix.length === 1 ? byPrefix[0]?.id : undefined
  }

  // ---- interactive list picker (sessions, models, efforts) -----------------

  /**
   * Inline arrow-key picker: draws heading + rows in place, ↑/↓ (or j/k)
   * move, Enter picks, Esc/q cancels. The selector borrows the keypress feed
   * wholesale — readline's own listener is parked so navigation keys neither
   * echo nor edit the line — then everything is restored exactly as found.
   * @returns the picked row index, or undefined on cancel.
   */
  const pickFromList = async (heading: string, rows: string[], startIndex: number, footer?: string): Promise<number | undefined> => {
    let index = Math.min(Math.max(0, startIndex), rows.length - 1)
    render.breakLine()
    const extraLines = footer === undefined ? 0 : 1
    const draw = (first: boolean): void => {
      if (!first) io.stdout.write(`\x1b[${rows.length + 1 + extraLines}A`)
      io.stdout.write(`\x1b[2K${DIM}${heading}${RESET}\n`)
      rows.forEach((row, i) => {
        io.stdout.write(`\x1b[2K${i === index ? `${CYAN}▸ ${row}${RESET}` : `  ${DIM}${row}${RESET}`}\n`)
      })
      if (footer !== undefined) io.stdout.write(`\x1b[2K${DIM}${footer}${RESET}\n`)
    }
    draw(true)
    return new Promise<number | undefined>(resolve => {
      const saved = [...process.stdin.listeners('keypress')] as ((...args: never[]) => void)[]
      process.stdin.removeAllListeners('keypress')
      const finish = (value: number | undefined): void => {
        process.stdin.removeAllListeners('keypress')
        for (const listener of saved) process.stdin.on('keypress', listener as (...args: unknown[]) => void)
        resolve(value)
      }
      process.stdin.on('keypress', (_str: unknown, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (key === undefined) return
        if (key.name === 'up' || key.name === 'k') { index = Math.max(0, index - 1); draw(false) }
        else if (key.name === 'down' || key.name === 'j') { index = Math.min(rows.length - 1, index + 1); draw(false) }
        else if (key.name === 'return' || key.name === 'enter') finish(index)
        else if (key.name === 'escape' || key.name === 'q' || (key.ctrl === true && key.name === 'c')) finish(undefined)
      })
    })
  }

  const runSessionSelector = async (): Promise<void> => {
    const mine = await listMine()
    if (mine.length === 0) { render.note(`(no ${config.sessionTag} sessions for ${cwd})`); return }
    if (process.stdin.isTTY !== true) { await printSessions(); return }
    const MAX_ROWS = 15
    const entries = mine.slice(0, MAX_ROWS)
    const rows: string[] = []
    for (const header of entries) {
      const title = (header.id === sessionId ? liveTitle() : undefined)
        ?? await coldTitle(persistence, header.id)
        ?? '(untitled)'
      const marker = header.id === sessionId ? ' (current)' : ''
      rows.push(`${title} · ${relativeAge(header.createdAt, Date.now())} · ${header.id.replace('session-', '').slice(0, 8)}${marker}`)
    }
    const footer = mine.length > MAX_ROWS ? `… ${mine.length - MAX_ROWS} more — /resume <id> reaches them` : undefined
    const chosen = await pickFromList('select a session — ↑/↓ move · enter switch · esc cancel', rows, 0, footer)
    if (chosen === undefined) { render.note('(cancelled)'); return }
    const target = entries[chosen]
    if (target === undefined) return
    if (target.id === sessionId) { render.note('already on that session'); return }
    await switchTo({ kind: 'resume', id: target.id })
  }

  // ---- history replay (static render, never a re-run) ----------------------

  const HISTORY_TAIL = 2
  let historyShownFrom = 0

  const sessionExchanges = (): HistoryExchange[] =>
    collectExchanges(agent.session.events as readonly { type: string; data?: unknown }[])

  const renderExchange = (exchange: HistoryExchange): void => {
    render.breakLine()
    io.stdout.write(`${DIM}» ${exchange.user}${RESET}\n`)
    for (const part of exchange.parts) {
      if (part.kind === 'tool') {
        render.toolCall(part.toolName ?? '?', part.args ?? '', toolView(part.toolName ?? '', part.args ?? '{}'))
      } else if (part.kind === 'error') {
        render.turnError('history', part.text)
      } else {
        render.textDelta(part.text.endsWith('\n') ? part.text : `${part.text}\n`)
        render.breakLine()
      }
    }
  }

  const renderHistoryTail = (): void => {
    const exchanges = sessionExchanges()
    historyShownFrom = Math.max(0, exchanges.length - HISTORY_TAIL)
    if (historyShownFrom > 0) {
      render.note(`… ${historyShownFrom} earlier exchange${historyShownFrom === 1 ? '' : 's'} hidden — /history ${Math.min(5, historyShownFrom)} shows more`)
    }
    for (const exchange of exchanges.slice(historyShownFrom)) renderExchange(exchange)
  }

  if (request.permission !== '') {
    try {
      const execution = await execCommand(`/permission ${request.permission}`)
      if (execution === undefined) render.note('permission: the /permission command is not registered in this profile')
      else if (execution.result.kind === 'error') render.turnError('permission', execution.result.text ?? execution.result.kind)
      else render.note(execution.result.text ?? execution.result.kind)
    } catch (error) {
      render.turnError('permission', error instanceof Error ? error.message : String(error))
    }
  }
  if (resumedMidTurn) render.note('(the resumed session had an unfinished turn — cancelled)')
  if (request.action === 'resume-last' || request.action === 'resume-session') renderHistoryTail()

  const statusText = (): string => {
    const sel = currentSelection()
    const effort = sel.reasoningEffort === undefined ? '' : ` (${String(sel.reasoningEffort)})`
    const title = liveTitle() ?? sessionId.replace('session-', '').slice(0, 8)
    return `${sel.provider}/${sel.model}${effort} · approvals:${approvalMode} · ${title} · ${cwd} · ctrl+o thinking · /help`
  }
  const updateStatus = (): void => { render.setStatus(statusText()) }
  repaintStatus = updateStatus
  if (process.stdout.isTTY === true) {
    process.stdout.on('resize', () => {
      render.enableStatusBar(false)
      updateStatus()
    })
    process.once('exit', () => { render.disableStatusBar() })
  }
  updateStatus()

  let pending: string | undefined = request.task === '' ? undefined : request.task
  for (;;) {
    updateStatus()
    let line: string
    if (pending === undefined) {
      line = await question()
    } else {
      line = pending
      pending = undefined
      io.stdout.write(`${PROMPT}${line}\n`)
    }
    if (closing) return
    const text = line.trim()
    if (text === '') continue
    if (text.startsWith('/')) {
      if (text === '/exit' || text === '/quit') { leave(0); return }
      if (text === '/session') { render.note(sessionId); continue }
      if (text === '/sessions') { await runSessionSelector(); continue }
      if (text === '/sessions list') { await printSessions(); continue }
      if (text === '/new') { await switchTo({ kind: 'new' }); continue }
      if (text === '/resume' || text.startsWith('/resume ')) {
        const arg = text.slice('/resume'.length).trim()
        if (arg === '') { render.note('usage: /resume <index|id> — /sessions lists them'); continue }
        const id = await resolveTarget(arg)
        if (id === undefined) render.note(`no ${config.sessionTag} session matches "${arg}" here`)
        else if (id === sessionId) render.note('already on that session')
        else await switchTo({ kind: 'resume', id })
        continue
      }
      if (text === '/approvals' || text.startsWith('/approvals ')) {
        const arg = text.slice('/approvals'.length).trim()
        if (arg === '') {
          render.note(`approvals: ${approvalMode} — usage: /approvals ask|auto`)
        } else if (arg === 'auto') {
          approvalMode = 'auto'
          render.note('approvals: auto — every request is allowed with an audit line (the sandbox still applies); /approvals ask restores prompts')
        } else if (arg === 'ask') {
          approvalMode = 'ask'
          render.note('approvals: ask — each request prompts y/N again')
        } else {
          render.note('usage: /approvals ask|auto')
        }
        continue
      }
      if (text === '/history' || text.startsWith('/history ')) {
        const arg = text.slice('/history'.length).trim()
        const count = arg === '' ? 5 : Number.parseInt(arg, 10)
        if (!Number.isInteger(count) || count < 1) { render.note('usage: /history [n]'); continue }
        if (historyShownFrom === 0) { render.note('(already at the start of the session)'); continue }
        const exchanges = sessionExchanges()
        const from = Math.max(0, historyShownFrom - count)
        render.note(`── earlier exchanges ${from + 1}–${historyShownFrom} of ${exchanges.length} ──`)
        for (const exchange of exchanges.slice(from, historyShownFrom)) renderExchange(exchange)
        historyShownFrom = from
        if (from === 0) render.note('(start of session)')
        continue
      }
      if (text === '/title' || text.startsWith('/title ')) {
        const arg = text.slice('/title'.length).trim()
        const titles = ctx.get('sessionTitle')
        if (titles === undefined) { render.note('session-title service unavailable'); continue }
        if (arg === '') { render.note(titles.get(agent.session)?.title ?? '(untitled)'); continue }
        try {
          render.note(`title: ${titles.rename(agent.session, arg).title}`)
        } catch (error) {
          render.turnError('title', error instanceof Error ? error.message : String(error))
        }
        continue
      }
      if (text === '/model' || text.startsWith('/model ')) {
        const arg = text.slice('/model'.length).trim()
        const llm = ctx.get('llm')
        const sel = currentSelection()
        if (arg === '') {
          let catalog: { id: string; name?: string }[] = []
          try {
            catalog = (await llm?.listModels(sel.provider) ?? [])
              .map(raw => raw as { id?: string; name?: string })
              .filter((info): info is { id: string; name?: string } => info.id !== undefined)
          } catch {
            // The catalog is advisory; listing can fail while switching still works.
          }
          if (process.stdin.isTTY === true && catalog.length > 0) {
            const rows = catalog.map(info => {
              const label = info.name !== undefined && info.name !== info.id ? ` — ${info.name}` : ''
              return `${info.id}${label}${info.id === sel.model ? ' (current)' : ''}`
            })
            const start = Math.max(0, catalog.findIndex(info => info.id === sel.model))
            const chosen = await pickFromList(
              `select a model (${sel.provider}) — ↑/↓ · enter · esc`,
              rows,
              start,
              'or type /model <provider>/<id> for another provider',
            )
            if (chosen === undefined) { render.note('(cancelled)'); continue }
            const picked = catalog[chosen]
            if (picked === undefined || picked.id === sel.model) { render.note(`model: ${sel.provider}/${sel.model} (unchanged)`); continue }
            setSelection({ provider: sel.provider, model: picked.id })
            render.note(`model: ${sel.provider}/${picked.id} (from the next step; remembered for this profile)`)
            continue
          }
          const lines = [`${sel.provider}/${sel.model}${sel.reasoningEffort === undefined ? '' : ` · effort ${String(sel.reasoningEffort)}`}`]
          for (const info of catalog) {
            const label = info.name !== undefined && info.name !== info.id ? ` — ${info.name}` : ''
            lines.push(`${info.id === sel.model ? '*' : ' '} ${info.id}${label}`)
          }
          lines.push('usage: /model <id> · /model <provider>/<id> · /model default')
          render.note(lines.join('\n'))
          continue
        }
        if (arg === 'default') {
          clearSelectionPref()
          const back = currentSelection()
          render.note(`model: ${back.provider}/${back.model} (machine default restored; preference cleared)`)
          continue
        }
        const slash = arg.indexOf('/')
        const provider = slash === -1 ? sel.provider : arg.slice(0, slash)
        const model = slash === -1 ? arg : arg.slice(slash + 1)
        try {
          // The adapter catalog is advisory (it never gates routing), so an
          // unknown id switches anyway — with a warning, since it will only
          // fail at the next request.
          if (llm !== undefined) {
            await llm.resolveModelInfo(provider, model)
            const known = (await llm.listModels(provider).catch(() => []))
              .some(info => (info as { id?: string }).id === model)
            if (!known) render.note(`warning: "${model}" is not in ${provider}'s catalog — a wrong id fails at the next request`)
          }
          setSelection({ provider, model })
          render.note(`model: ${provider}/${model} (from the next step; remembered for this profile)`)
        } catch (error) {
          render.turnError('model', error instanceof Error ? error.message : String(error))
        }
        continue
      }
      if (text === '/effort' || text.startsWith('/effort ')) {
        const arg = text.slice('/effort'.length).trim()
        const sel = currentSelection()
        const llm = ctx.get('llm')
        let efforts: readonly string[] = []
        try {
          const info = await llm?.resolveModelInfo(sel.provider, sel.model)
          efforts = (info?.reasoning?.efforts ?? []).map(effort => String(effort.id))
        } catch {
          // Effort metadata is optional; setting an effort blindly still works.
        }
        if (arg === '') {
          if (process.stdin.isTTY === true && efforts.length > 0) {
            const rows = [
              `(provider default)${sel.reasoningEffort === undefined ? ' (current)' : ''}`,
              ...efforts.map(id => `${id}${id === String(sel.reasoningEffort) ? ' (current)' : ''}`),
            ]
            const start = sel.reasoningEffort === undefined ? 0 : efforts.indexOf(String(sel.reasoningEffort)) + 1
            const chosen = await pickFromList(`select reasoning effort (${sel.model}) — ↑/↓ · enter · esc`, rows, Math.max(0, start))
            if (chosen === undefined) { render.note('(cancelled)'); continue }
            if (chosen === 0) {
              setSelection({ provider: sel.provider, model: sel.model })
              render.note('effort: provider default (from the next step; remembered)')
            } else {
              const picked = efforts[chosen - 1]
              if (picked === undefined) continue
              setSelection({
                provider: sel.provider,
                model: sel.model,
                reasoningEffort: picked as NonNullable<LiveSelection['reasoningEffort']>,
              })
              render.note(`effort: ${picked} (from the next step; remembered)`)
            }
            continue
          }
          render.note([
            `effort: ${sel.reasoningEffort === undefined ? '(provider default)' : String(sel.reasoningEffort)}`,
            ...efforts.map(id => `${id === String(sel.reasoningEffort) ? '*' : ' '} ${id}`),
            'usage: /effort <id> or /effort default',
          ].join('\n'))
          continue
        }
        if (arg === 'default') {
          setSelection({ provider: sel.provider, model: sel.model })
          render.note('effort: provider default (from the next step; remembered)')
          continue
        }
        if (efforts.length > 0 && !efforts.includes(arg)) {
          render.note(`unknown effort "${arg}" — available: ${efforts.join(', ')}`)
          continue
        }
        setSelection({
          provider: sel.provider,
          model: sel.model,
          reasoningEffort: arg as NonNullable<LiveSelection['reasoningEffort']>,
        })
        render.note(`effort: ${arg} (from the next step; remembered)`)
        continue
      }
      const commands = ctx.get('commands')
      if (text === '/help') {
        const registered = commands === undefined ? [] : commands.list(agent).map(c => `/${c.name} — ${c.description}`)
        render.note([
          '/exit · /session · /sessions · /new · /resume <n|id> · /history [n] · /title [text] · /model [id] · /effort [id] · /approvals [ask|auto] · Ctrl-C cancels a running turn (twice to quit)',
          ...registered,
        ].join('\n'))
        continue
      }
      // Harness-registered slash commands (/compact, /permission, …) execute
      // directly against the agent, never through the model.
      if (commands !== undefined) {
        try {
          const execution = await execCommand(text)
          if (execution === undefined) {
            render.note('unknown command — /help lists what this profile offers')
          } else if (execution.result.kind === 'error') {
            render.turnError('command', execution.result.text ?? execution.result.kind)
          } else {
            render.note(execution.result.text ?? execution.result.kind)
          }
        } catch (error) {
          render.turnError('command', error instanceof Error ? error.message : String(error))
        }
        continue
      }
      render.note('unknown command (no command registry in this profile)')
      continue
    }

    running = true
    resetUsage()
    render.clearTurnDetail()
    render.startSpinner()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    // Settle on whole-agent idle, not turn/end: other producers may run
    // further turns on this agent before it goes quiet.
    await agent.whenIdle()
    running = false
    render.stopSpinner()
    render.breakLine()
    if (exchangeUsage.steps > 0) render.usageLine(exchangeUsage)
    await sessions.flush(agent.session)
  }
}

/** Mount the REPL and keep the process alive until the user leaves. */
export function apply(ctx: Context, config: Config): void {
  assertRunnable(config)
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io: Io = { stdout: process.stdout, stderr: process.stderr, exit, graceMs: config.exitGraceMs }
  run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
