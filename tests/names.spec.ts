import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BlockTranslator } from '../src/convert/blocks.ts'
import type { ResponsesEvent } from '../src/api/events.ts'
import { MAX_TOOL_NAME_LENGTH, SAFE_TOOL_NAME, ToolNameTable, safeToolName } from '../src/convert/names.ts'
import { toResponsesBody, toolNames } from '../src/convert/request.ts'

/** Feed one tool call through a translator and return the block DSH receives. */
function translatedCall(name: string, table?: ToolNameTable): { id: string, name: string } | undefined {
  const translator = new BlockTranslator(undefined, table)
  const events: ResponsesEvent[] = [
    { kind: 'toolCallStart', index: 0, callId: 'call_1', name },
    { kind: 'toolCallEnd', index: 0, arguments: '{}' },
  ]
  const chunks = events.flatMap(event => translator.push(event))
  const end = chunks.find(chunk => chunk.type === 'block-end')
  const block = end?.type === 'block-end' ? end.block : undefined
  return block?.type === 'tool-call' ? { id: block.id, name: block.name } : undefined
}

describe('safeToolName', () => {
  it('replaces every character outside the provider contract', () => {
    assert.equal(safeToolName('acp tokens='), 'acp_tokens_')
    assert.equal(safeToolName('bash'), 'bash')
    assert.equal(safeToolName('orchestrator.ticket_request_status'), 'orchestrator.ticket_request_status')
    assert.equal(safeToolName('mcp__server__tool'), 'mcp__server__tool')
    assert.equal(safeToolName('工具/读取'), '_____')
  })

  it('keeps the name inside the length ceiling', () => {
    const long = safeToolName('a'.repeat(200))
    assert.equal(long.length, MAX_TOOL_NAME_LENGTH)
    assert.equal(SAFE_TOOL_NAME.test(long), true)
  })

  it('never returns an empty name', () => {
    assert.equal(safeToolName(''), 'tool')
    assert.equal(safeToolName('  '), '__')
  })
})

describe('ToolNameTable', () => {
  it('keeps a legal name as-is and maps it back', () => {
    const table = new ToolNameTable()
    assert.equal(table.wire('bash'), 'bash')
    assert.equal(table.raw('bash'), 'bash')
  })

  it('gives colliding names distinct wire names and resolves each back', () => {
    const table = new ToolNameTable()
    const first = table.wire('acp tokens=')
    const second = table.wire('acp_tokens_')
    assert.equal(first, 'acp_tokens_')
    assert.equal(second, 'acp_tokens__2')
    assert.equal(table.raw(first), 'acp tokens=')
    assert.equal(table.raw(second), 'acp_tokens_')
    // Assignment is stable for the request.
    assert.equal(table.wire('acp tokens='), first)
  })

  it('keeps suffixed truncations inside the ceiling and unique', () => {
    const table = new ToolNameTable()
    const base = 'a'.repeat(MAX_TOOL_NAME_LENGTH)
    const first = table.wire(base)
    const second = table.wire(`${base} b`)
    assert.equal(SAFE_TOOL_NAME.test(first), true)
    assert.equal(SAFE_TOOL_NAME.test(second), true)
    assert.equal(second.length <= MAX_TOOL_NAME_LENGTH, true)
    assert.notEqual(first, second)
    assert.equal(table.raw(second), `${base} b`)
  })
})

describe('toResponsesBody tool names', () => {
  it('normalizes a recorded function call name that the route would reject', () => {
    const body = toResponsesBody({
      model: 'gpt-6.1-sol',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_00', name: 'acp tokens=', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_00', content: 'Error: unknown tool "acp tokens="', isError: true },
        { role: 'user', content: 'continue' },
      ],
    })
    // The only name on the wire obeys the contract; the result text is untouched.
    assert.deepEqual(body.input.map(item => item['name']).filter(name => name !== undefined), ['acp_tokens_'])
    assert.equal(SAFE_TOOL_NAME.test('acp tokens='), false)
  })

  it('normalizes replay items and keeps the call id pairing', () => {
    const body = toResponsesBody({
      model: 'gpt-6.1-sol',
      messages: [{
        role: 'assistant',
        content: '',
        replay: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'acp tokens=', arguments: '{}' }],
      }],
    })
    assert.deepEqual(body.input, [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'acp_tokens_', arguments: '{}' }])
  })

  it('normalizes tool definitions and resolves the streamed call back to the DSH tool', () => {
    const request = {
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [{ name: 'read file', description: 'read', parameters: { type: 'object' } }],
    }
    const names = toolNames(request)
    const body = toResponsesBody(request, names)
    assert.deepEqual(body.tools?.map(tool => tool.name), ['read_file'])
    // The model answers with the wire name; DSH must see the tool it dispatches.
    assert.deepEqual(translatedCall('read_file', names), { id: 'call_1', name: 'read file' })
    // Without the table the translator passes wire names through unchanged.
    assert.deepEqual(translatedCall('read_file'), { id: 'call_1', name: 'read_file' })
  })
})
