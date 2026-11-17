import { McpServer } from '@modelcontextprotocol/server';
import {
  GlinkToolName,
  ToolAccess,
  toolsPath,
  workspaceTools,
  type ToolDefinition,
  type ToolErrorResponse,
  type ToolResults,
} from '@glink/protocol/tools';

/** Registers the local tool catalog without contacting or starting the backend. */
export function createGlinkMcpServer(backendUrl: URL) {
  const server = new McpServer(
    {
      name: 'glink',
      version: '0.0.0',
    },
    {
      instructions: 'Glink tools remain available while its backend is offline. '
        + 'If a tool reports a connection failure, ask the user to start Glink and call it again. '
        + 'After an interrupted write, read the workspace before deciding whether to repeat it.',
    },
  );

  for (const [name, definition] of Object.entries<ToolDefinition>(workspaceTools)) {
    const endpoint = new URL(`${toolsPath}/${name}`, backendUrl);

    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: definition.access === ToolAccess.read,
          destructiveHint: name === GlinkToolName.removeWorkspace
            || name === GlinkToolName.removeProject,
          openWorldHint: false,
        },
      },
      async (input, context) => {
        try {
          let response: Response;

          try {
            response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(input),
              signal: context.mcpReq.signal,
              redirect: 'error',
            });
          } catch (error: unknown) {
            context.mcpReq.signal.throwIfAborted();

            throw new Error(
              `无法请求 Glink 后端（${backendUrl.origin}）。请先启动后端，然后重试此工具。`
              + ` ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }

          if (!response.ok) {
            const failure = await response.json() as ToolErrorResponse;
            throw new Error(failure.error);
          }

          const output = await response.json() as ToolResults[GlinkToolName];

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(output),
              },
            ],
            structuredContent: output,
          };
        } catch (error: unknown) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}
