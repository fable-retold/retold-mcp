# retold-mcp

Serve any meadow-endpoints REST API to AI agents over the Model Context Protocol.

retold-mcp is the protocol engine. You give it a meadow-endpoints base URL, a
bearer token, and a catalog of tools, resources, and prompts; it serves that
catalog to an MCP client (Claude Code, the Claude API connector, Managed Agents)
over stdio or streamable HTTP. It knows MCP and meadow's route conventions
(pluralized list, /Entity/:id read, POST create, PUT update, /Schema discovery).
It does not know any application's entities. Those live in the catalog you pass.

The application-specific half (the catalog: which entities, the composite tools,
the prompts, the entitlement gate) is a separate package that depends on this
one. See plansheet-mcp for the first consumer.

## Use

	const libRetoldMCP = require('retold-mcp');

	let tmpMCP = new libRetoldMCP(pFable, { URL: 'https://plansheet.io', Token: process.env.PLANSHEET_TOKEN });
	tmpMCP.registerCatalog(require('./My-Catalog.js')(tmpMCP.client));
	await tmpMCP.serveStdio();

The MCP SDK (@modelcontextprotocol/sdk) is ESM-only; this module is CommonJS and
dynamic-imports it, so nothing here needs "type": "module".

## Layout

	source/Retold-MCP-Service.cjs       Fable service wrapper (main)
	source/Retold-MCP-Server.cjs        MCP server bootstrap (transports, catalog registration)
	source/Retold-MCP-MeadowClient.cjs  meadow-endpoints REST client (bearer, routes, /Schema)

## Status

Early scaffold. The stdio edge is wired; the streamable-HTTP edge (serveHTTP) is
a stub. The high-level tool/resource/prompt registration calls follow the MCP
SDK's current API and should be pinned to the installed SDK version.
