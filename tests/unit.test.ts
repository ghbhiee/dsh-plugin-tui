import { describe, expect, it, vi } from 'vitest'
import {
  assertRunnable,
  MdStyler,
  normalizeSessionId,
  relativeAge,
  Renderer,
  sessionsInCwd,
  styleInlineMd,
  titleFromEvents,
  toolCallLabel,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    request: { action: 'new', task: '', sessionId: '', autoApprove: false, permission: '' },
    sessionTag: 'tui',
    exitGraceMs: 1500,
    sigintExitWindowMs: 1500,
    ...overrides,
  }
}

/** A writable stub that records everything written, stripped of ANSI codes on demand. */
function sink(): { stream: NodeJS.WritableStream; raw: () => string; plain: () => string } {
  let buffer = ''
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    },
  } as NodeJS.WritableStream
  return {
    stream,
    raw: () => buffer,
    // eslint-disable-next-line no-control-regex
    plain: () => buffer.replace(/\x1b\[[0-9;]*m/g, ''),
  }
}

describe('toolCallLabel', () => {
  it('passes short arguments through with whitespace collapsed', () => {
    expect(toolCallLabel('{"a": 1,\n  "b": 2}')).toBe('{"a": 1, "b": 2}')
  })

  it('truncates long arguments to the limit with an ellipsis', () => {
    const label = toolCallLabel('x'.repeat(300), 100)
    expect(label).toHaveLength(100)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('normalizeSessionId', () => {
  it('prefixes a bare id', () => {
    expect(normalizeSessionId('abc')).toBe('session-abc')
  })

  it('keeps an already-prefixed id', () => {
    expect(normalizeSessionId('session-abc')).toBe('session-abc')
  })
})

describe('sessionsInCwd', () => {
  const headers = [
    { id: 'a', cwd: '/x', createdAt: 1, agentPreset: 'tui' },
    { id: 'b', cwd: '/x', createdAt: 3, agentPreset: 'tui' },
    { id: 'c', cwd: '/y', createdAt: 2, agentPreset: 'tui' },
    { id: 'd', cwd: '/x', createdAt: 4, agentPreset: 'chat-cli' },
  ]

  it('filters by cwd and tag, newest first', () => {
    expect(sessionsInCwd(headers, '/x', 'tui').map(header => header.id)).toEqual(['b', 'a'])
  })

  it('returns empty when nothing matches', () => {
    expect(sessionsInCwd(headers, '/z', 'tui')).toEqual([])
  })
})

describe('titleFromEvents', () => {
  it('returns the latest title event, not the first', () => {
    expect(titleFromEvents([
      { type: 'session/title', data: { title: 'old' } },
      { type: 'assistant/message', data: {} },
      { type: 'session/title', data: { title: 'new' } },
    ])).toBe('new')
  })

  it('returns undefined when no title event exists', () => {
    expect(titleFromEvents([{ type: 'turn/start' }])).toBeUndefined()
  })
})

describe('relativeAge', () => {
  it('reports minutes, hours, then days', () => {
    const now = 100 * 24 * 3_600_000
    expect(relativeAge(now - 3 * 60_000, now)).toBe('3m ago')
    expect(relativeAge(now - 5 * 3_600_000, now)).toBe('5h ago')
    expect(relativeAge(now - 3 * 24 * 3_600_000, now)).toBe('3d ago')
  })
})

describe('assertRunnable', () => {
  it('accepts a sensible configuration', () => {
    expect(() => { assertRunnable(makeConfig()) }).not.toThrow()
  })

  it('rejects a blank session tag', () => {
    expect(() => { assertRunnable(makeConfig({ sessionTag: '  ' })) }).toThrow(/sessionTag/)
  })

  it('rejects a negative exit grace', () => {
    expect(() => { assertRunnable(makeConfig({ exitGraceMs: -1 })) }).toThrow(/exitGraceMs/)
  })
})

describe('Renderer', () => {
  it('streams text deltas verbatim once the line breaks', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('hel')
    render.textDelta('lo')
    render.flush()
    expect(out.plain()).toBe('')
    render.breakLine()
    expect(out.plain()).toBe('hello\n')
  })

  it('micro-batches deltas until a flush', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('queued\n')
    expect(out.plain()).toBe('')
    render.flush()
    expect(out.plain()).toBe('queued\n')
  })

  it('breaks the line once before a structural line after a mid-line delta', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('answer without newline')
    render.toolCall('bash', '{"command":"ls"}')
    expect(out.plain()).toBe('answer without newline\n⏺ bash {"command":"ls"}\n')
  })

  it('does not double-break after a delta that already ended the line', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('done\n')
    render.note('bye')
    expect(out.plain()).toBe('done\nbye\n')
  })

  it('separates a reasoning run from the following text run', () => {
    const out = sink()
    const render = new Renderer(out.stream, { reasoningVisible: true })
    render.reasoningDelta('thinking')
    render.textDelta('answer')
    render.flush()
    render.breakLine()
    expect(out.plain()).toBe('thinking\nanswer\n')
  })

  it('keeps consecutive same-kind deltas unseparated', () => {
    const out = sink()
    const render = new Renderer(out.stream, { reasoningVisible: true })
    render.reasoningDelta('a')
    render.reasoningDelta('b')
    render.flush()
    expect(out.plain()).toBe('ab')
  })

  it('draws the spinner on quiet lines and erases it before real output', () => {
    vi.useFakeTimers()
    try {
      const out = sink()
      const render = new Renderer(out.stream)
      render.startSpinner()
      vi.advanceTimersByTime(130)
      expect(out.raw()).toContain('⠋')
      render.textDelta('hi')
      render.flush()
      render.breakLine()
      render.stopSpinner()
      expect(out.raw()).toContain('\r\x1b[2K')
      expect(out.plain().endsWith('hi\n')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never draws the spinner over a mid-line reasoning run', () => {
    vi.useFakeTimers()
    try {
      const out = sink()
      const render = new Renderer(out.stream, { reasoningVisible: true })
      render.reasoningDelta('partial thought')
      render.flush()
      render.startSpinner()
      vi.advanceTimersByTime(500)
      expect(out.raw()).not.toContain('⠋')
      render.stopSpinner()
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses thinking by default into the spinner tail', () => {
    vi.useFakeTimers()
    try {
      const out = sink()
      const render = new Renderer(out.stream)
      render.reasoningDelta('pondering the answer')
      render.flush()
      expect(out.plain()).toBe('')
      render.startSpinner()
      vi.advanceTimersByTime(130)
      expect(out.plain()).toContain('pondering the answer')
      render.stopSpinner()
    } finally {
      vi.useRealTimers()
    }
  })

  it('streams a stalled partial line after the idle window', () => {
    vi.useFakeTimers()
    try {
      const out = sink()
      const render = new Renderer(out.stream)
      render.textDelta('partial without newline')
      render.flush()
      expect(out.plain()).toBe('')
      vi.advanceTimersByTime(300)
      expect(out.plain()).toBe('partial without newline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('styles complete markdown lines as they land', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('# Title\nplain body\n')
    render.flush()
    expect(out.plain()).toBe('# Title\nplain body\n')
    expect(out.raw()).toContain('\x1b[1m# Title')
  })

  it('streams an over-long unbroken line raw instead of buffering it', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('x'.repeat(250))
    render.flush()
    expect(out.plain()).toBe('x'.repeat(250))
  })

  it('prefers a presenter view title over the raw argument line', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.toolCall('write', '{"file_path":"a.txt"}', { card: 'diff', title: 'Write a.txt' })
    expect(out.plain()).toBe('⏺ Write a.txt\n')
  })

  it('renders a terminal view as its task description, not the command', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.toolCall('bash', '{"command":"ls"}', { card: 'terminal', title: 'ls -la', description: 'List files' })
    expect(out.plain()).toBe('⏺ List files\n')
  })

  it('falls back to the clipped first command line without a description', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.toolCall('bash', '{}', { card: 'terminal', title: 'ls -la' })
    expect(out.plain()).toBe('⏺ $ ls -la\n')
  })

  it('summarizes a heredoc script to one line and buffers the code as detail', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    const script = "python3 - <<'EOF'\nprint(1)\nprint(2)\nEOF"
    render.toolCall('bash', '{}', { card: 'terminal', title: script, description: 'Group counts' })
    expect(out.plain()).toBe('⏺ Group counts (+3 lines)\n')
    expect(out.plain()).not.toContain('print(1)')
    render.toggleReasoning()
    expect(out.plain()).toContain('── bash ──')
    expect(out.plain()).toContain('print(1)')
  })

  it('keeps detail through turn end but clears it as the next exchange starts', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.toolCall('bash', '{}', { card: 'terminal', title: 'a\nb', description: 'Task' })
    render.stopSpinner()
    render.toggleReasoning()
    expect(out.plain()).toContain('── bash ──')
    render.toggleReasoning()
    render.clearTurnDetail()
    render.toggleReasoning()
    expect(out.plain().split('── bash ──')).toHaveLength(2)
  })

  it('renders turn errors on their own line', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.textDelta('partial')
    render.turnError('llm/timeout', 'took too long')
    expect(out.plain()).toBe('partial\n✖ llm/timeout: took too long\n')
  })
})

describe('styleInlineMd', () => {
  it('colors code spans and bolds double-star runs', () => {
    const styled = styleInlineMd('run `ls` **now** please')
    expect(styled).toContain('\x1b[36mls\x1b[39m')
    expect(styled).toContain('\x1b[1mnow\x1b[22m')
  })

  it('leaves plain text untouched', () => {
    expect(styleInlineMd('2 * 3 * 4 equals 24')).toBe('2 * 3 * 4 equals 24')
  })
})

describe('MdStyler', () => {
  it('bolds headings and dims fence markers, greening fenced content', () => {
    const md = new MdStyler()
    expect(md.line('## Setup')).toContain('\x1b[1m')
    expect(md.line('```js')).toContain('\x1b[2m')
    expect(md.line('const x = 1')).toContain('\x1b[32m')
    expect(md.line('```')).toContain('\x1b[2m')
    expect(md.line('back to `inline`')).toContain('\x1b[36minline\x1b[39m')
  })

  it('colors list bullets but styles the item text inline', () => {
    const md = new MdStyler()
    const styled = md.line('- item with `code`')
    expect(styled).toContain('\x1b[36m-\x1b[0m')
    expect(styled).toContain('\x1b[36mcode\x1b[39m')
  })
})

describe('fmtTokens', () => {
  it('formats counts compactly', async () => {
    const { fmtTokens } = await import('../src/index.ts')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(12345)).toBe('12.3k')
    expect(fmtTokens(123456)).toBe('123k')
  })
})

describe('Renderer todo and usage lines', () => {
  it('renders the todo snapshot as a checklist', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.todoList([
      { content: 'buy milk', status: 'completed' },
      { content: 'walk dog', status: 'in_progress' },
      { content: 'sleep', status: 'pending' },
    ])
    expect(out.plain()).toBe('  ☑ buy milk\n  ◐ walk dog\n  ☐ sleep\n')
  })

  it('prints a compact usage line, omitting zero extras', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.usageLine({ inputTokens: 1200, outputTokens: 89, cacheReadTokens: 0, reasoningTokens: 4500 })
    expect(out.plain()).toBe('↳ 1.2k in · 89 out · 4.5k reasoning\n')
  })
})

describe('collectExchanges', () => {
  it('folds user text, assistant text, tools, and errors into exchanges', async () => {
    const { collectExchanges } = await import('../src/index.ts')
    const exchanges = collectExchanges([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant/chunk', data: {} },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello!' }] } } },
      { type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: 'injected' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'run ls' }] } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'llm/x', message: 'boom' } } } },
    ])
    expect(exchanges).toHaveLength(2)
    expect(exchanges[0]).toEqual({ user: 'hi', parts: [{ kind: 'text', text: 'hello!' }] })
    expect(exchanges[1]?.user).toBe('run ls')
    expect(exchanges[1]?.parts[0]).toMatchObject({ kind: 'tool', toolName: 'bash' })
    expect(exchanges[1]?.parts[1]).toMatchObject({ kind: 'error', text: 'llm/x: boom' })
  })

  it('ignores assistant output before any user message', async () => {
    const { collectExchanges } = await import('../src/index.ts')
    expect(collectExchanges([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'orphan' }] } } },
    ])).toEqual([])
  })
})

describe('displayWidth and tailByWidth', () => {
  it('counts CJK as two columns', async () => {
    const { displayWidth } = await import('../src/index.ts')
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('问题')).toBe(4)
    expect(displayWidth('a问b')).toBe(4)
  })

  it('keeps the trailing portion within the column budget', async () => {
    const { tailByWidth, displayWidth } = await import('../src/index.ts')
    const tail = tailByWidth('让我看看需求类反馈的具体内容', 10)
    expect(displayWidth(tail)).toBeLessThanOrEqual(10)
    expect('让我看看需求类反馈的具体内容'.endsWith(tail)).toBe(true)
    expect(tail.length).toBeGreaterThan(0)
  })

  it('never lets the spinner tail exceed the terminal width in columns', () => {
    const out = sink() as ReturnType<typeof sink> & { stream: NodeJS.WritableStream & { columns?: number } }
    ;(out.stream as { columns?: number }).columns = 40
    vi.useFakeTimers()
    try {
      const render = new Renderer(out.stream)
      render.reasoningDelta('问题。让我看看需求类反馈的具体内容，找一些模式。我已经有足够的材料来总结了。让我再想想。')
      render.flush()
      render.startSpinner()
      vi.advanceTimersByTime(130)
      const block = (out.plain().split('\r').pop() ?? '').split('\n')
      expect(block.length).toBeGreaterThan(0)
      expect(block.length).toBeLessThanOrEqual(3)
      // every row of the block must fit in 40 columns
      for (const line of block) {
        let width = 0
        for (const ch of line) {
          const code = ch.codePointAt(0) ?? 0
          width += code >= 0x2e80 ? 2 : 1
        }
        expect(width).toBeLessThanOrEqual(40)
      }
      render.stopSpinner()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('wrapByWidth', () => {
  it('wraps by display columns, CJK-aware', async () => {
    const { wrapByWidth, displayWidth } = await import('../src/index.ts')
    const rows = wrapByWidth('让我看看需求类反馈的具体内容找一些模式', 10)
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(10)
    expect(rows.join('')).toBe('让我看看需求类反馈的具体内容找一些模式')
  })
})

describe('Renderer status bar', () => {
  function ttySink(rows: number, cols: number) {
    const base = sink()
    ;(base.stream as { rows?: number; columns?: number }).rows = rows
    ;(base.stream as { rows?: number; columns?: number }).columns = cols
    return base
  }

  it('reserves the last row via a scroll region and draws there', () => {
    const out = ttySink(24, 80)
    const render = new Renderer(out.stream)
    render.enableStatusBar()
    render.setStatus('model · info')
    expect(out.raw()).toContain('\x1b[1;22r')
    expect(out.raw()).toContain('\x1b[23;1H')
    expect(out.raw()).toContain('─')
    expect(out.raw()).toContain('\x1b[24;1H')
    expect(out.raw()).toContain('model · info')
    expect(out.raw()).toContain('\x1b[90m')
    expect(out.raw()).not.toContain('\x1b[7m')
  })

  it('clips status content to the terminal width in display columns', () => {
    const out = ttySink(24, 30)
    const render = new Renderer(out.stream)
    render.enableStatusBar()
    render.setStatus('中文状态栏信息很长很长很长很长很长很长很长')
    const seg = out.raw().split('\x1b[24;1H').pop() ?? ''
    const text = seg.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b[78]/g, '')
    let width = 0
    for (const ch of text) width += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1
    expect(width).toBeLessThanOrEqual(30)
  })

  it('restores the full region on disable', () => {
    const out = ttySink(24, 80)
    const render = new Renderer(out.stream)
    render.enableStatusBar()
    render.disableStatusBar()
    expect(out.raw()).toContain('\x1b[r')
  })

  it('does nothing without a row count (not a TTY)', () => {
    const out = sink()
    const render = new Renderer(out.stream)
    render.enableStatusBar()
    render.setStatus('ignored')
    expect(out.raw()).toBe('')
  })
})
