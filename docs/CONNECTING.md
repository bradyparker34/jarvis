# Connecting agents

Jarvis speaks MCP two ways. Use stdio for desktop clients, the HTTP bridge for
everything else.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "jarvis": {
      "command": "node",
      "args": ["--experimental-strip-types", "/ABSOLUTE/PATH/jarvis/src/mcp/stdio.ts"],
      "env": {
        "DATABASE_URL": "postgresql://jarvis:jarvis_local_dev@127.0.0.1:5464/jarvis",
        "JARVIS_CALLER": "claude-desktop"
      }
    }
  }
}
```

Restart the app. The tools appear under the connectors icon.

## Claude Code

```bash
claude mcp add jarvis -- node --experimental-strip-types /ABSOLUTE/PATH/jarvis/src/mcp/stdio.ts
```

Set `DATABASE_URL` in the shell it inherits, or add `--env DATABASE_URL=...`.

## Cursor

`.cursor/mcp.json` in the project, or the global one in `~/.cursor/`. Same shape
as the Claude Desktop block above.

## ChatGPT, n8n, your own agents

```bash
npm run serve
```

Bound to `127.0.0.1:8787`, bearer token required.

```bash
curl -s localhost:8787/tools -H "authorization: Bearer $JARVIS_HTTP_TOKEN"

curl -s -X POST localhost:8787/tools/recall \
  -H "authorization: Bearer $JARVIS_HTTP_TOKEN" \
  -H "content-type: application/json" \
  -H "x-jarvis-caller: my-agent" \
  -d '{"query":"what did we agree on hosting rates","spaces":["bitdeer"]}'
```

Set `x-jarvis-caller` per agent. It lands in the `retrievals` table, so when an
agent says something strange you can see exactly what it read.

Anything outside localhost needs a tunnel you control and a second opinion about
whether you want your entire correspondence reachable from the internet. The
default answer is no.

## Writing agent prompts against this

Three habits make the difference between an agent that uses the graph and one
that merely has access to it:

**Call `who_is` before writing to anyone.** It returns preferences, history and
open commitments. The cost is one tool call; the gain is not asking someone
something they told you in March.

**Pass `input_ids` to `log_decision`.** The ids from `recall` results. Without
them you cannot later distinguish a good call made on good information from a
lucky one made on none.

**Make the prediction mandatory.** A decision with no expected outcome can never
be graded, so it teaches nothing. If the outcome is not measurable, say so in
the rationale rather than inventing a number.
