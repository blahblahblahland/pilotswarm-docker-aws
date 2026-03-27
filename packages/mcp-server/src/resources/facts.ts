import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerFactsResources(server: McpServer, ctx: ServerContext) {
    server.registerResource(
        "facts-query",
        "pilotswarm://facts",
        {
            title: "Facts Query",
            description: "Query the PilotSwarm facts/knowledge store",
            mimeType: "application/json",
        },
        async (uri) => {
            const params = uri.searchParams;
            const query: Record<string, unknown> = {};

            const pattern = params.get("pattern");
            if (pattern) query.keyPattern = pattern;

            const tags = params.get("tags");
            if (tags) query.tags = tags.split(",");

            const limit = params.get("limit");
            if (limit) query.limit = parseInt(limit, 10);

            const result = await ctx.facts.readFacts(query);
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: JSON.stringify(result, null, 2),
                        mimeType: "application/json",
                    },
                ],
            };
        },
    );
}
