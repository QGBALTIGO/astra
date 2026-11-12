# CLI Tool Calling Spec

This document defines the single tool-calling contract for CLI-backed chat providers in OwnPilot.

## Goal

- Keep one stable contract across Claude, Gemini, and Codex.
- Let providers differ in transport, not in tool semantics.
- Keep tool execution inside the gateway.

## Runtime Modes

- Native MCP: provider calls the `ownpilot` MCP server directly.
- Structured bridge: provider returns a strict JSON envelope that the gateway executes.

Both modes map to the same loop:

1. Model decides whether it needs tools.
2. Model emits tool intent.
3. Gateway executes tools.
4. Gateway returns tool results.
5. Model emits another tool intent or a final response.

## Standard Tool Surface

All CLI providers should target the same 4 meta-tools:

- `search_tools`
- `get_tool_help`
- `use_tool`
- `batch_use_tool`

The model should never call OwnPilot HTTP endpoints directly.

## Structured Bridge Contract

When native MCP is not available or not reliable enough, the provider must return exactly one JSON object and nothing else.

### Tool Intent

```json
{
  "type": "ownpilot_tool_intent",
  "calls": [
    {
      "name": "use_tool",
      "arguments": {
        "tool_name": "core.list_tasks",
        "arguments": {
          "status": "pending"
        }
      }
    }
  ]
}
```

### Final Response

```json
{
  "type": "ownpilot_final_response",
  "content": "You have 3 pending tasks."
}
```

### Tool Results Payload

The gateway feeds tool execution results back to the model as JSON:

```json
{
  "type": "ownpilot_tool_results",
  "results": [
    {
      "toolCallId": "bridge_123",
      "isError": false,
      "content": "..."
    }
  ]
}
```

## Validation Rules

- The provider output must be one valid JSON object.
- `ownpilot_tool_intent` must contain at least one valid call.
- Each call must include `name` and object `arguments`.
- `ownpilot_final_response` must contain string `content`.
- If parsing fails, the gateway sends one or more repair turns asking for valid JSON only.

## Compatibility

- Claude can use native MCP directly.
- Gemini and Codex can use the structured bridge.
- Legacy tag-based bridge output is tolerated temporarily for backward compatibility, but new integrations should use the JSON envelope only.
