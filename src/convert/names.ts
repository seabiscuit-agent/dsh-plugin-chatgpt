/**
 * Provider-safe tool names.
 *
 * A tool name outside `^[a-zA-Z0-9_.-]+$` is legal for DSH — it accepts whatever
 * a model emits and stores it verbatim — but the Responses route validates every
 * `function_call.name` and every `function.name` in the whole body, so one such
 * name recorded in the transcript fails the entire turn with
 * 400 `invalid_value` (`Invalid 'input[N].name'`). Renaming at the wire boundary
 * keeps the transcript usable and leaves dispatch untouched: the wire name is
 * mapped back to the recorded name when the model calls it.
 */

/** The character set the Responses route accepts for a function name. */
export const SAFE_TOOL_NAME = /^[a-zA-Z0-9_.-]+$/

/** OpenAI's documented ceiling for a function name. */
export const MAX_TOOL_NAME_LENGTH = 64

/** One name made safe: unsupported characters become `_`, the rest is bounded. */
export function safeToolName(raw: string): string {
  const replaced = raw.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const bounded = replaced.length > MAX_TOOL_NAME_LENGTH ? replaced.slice(0, MAX_TOOL_NAME_LENGTH) : replaced
  return bounded.length === 0 ? 'tool' : bounded
}

/** Keep a number suffix inside the length ceiling. */
function withSuffix(base: string, suffix: number): string {
  const tail = `_${suffix}`
  return `${base.slice(0, Math.max(0, MAX_TOOL_NAME_LENGTH - tail.length))}${tail}`
}

/**
 * The bidirectional name map of one request.
 *
 * Names are assigned in order of first appearance, so a live tool definition owns
 * its wire name and a transcript entry that would collide is the one that gets a
 * suffix. Both directions are stable for the request's lifetime, which is what
 * lets a streamed call be resolved back to the tool DSH dispatches.
 */
export class ToolNameTable {
  private readonly wireNames = new Map<string, string>()
  private readonly rawNames = new Map<string, string>()

  /** The wire name for a recorded tool name. */
  wire(raw: string): string {
    const known = this.wireNames.get(raw)
    if (known !== undefined) return known
    const base = safeToolName(raw)
    let candidate = base
    for (let suffix = 2; this.rawNames.has(candidate); suffix += 1) candidate = withSuffix(base, suffix)
    this.wireNames.set(raw, candidate)
    this.rawNames.set(candidate, raw)
    return candidate
  }

  /** The recorded tool name a wire name stands for; unknown names pass through. */
  raw(wire: string): string {
    return this.rawNames.get(wire) ?? wire
  }
}
