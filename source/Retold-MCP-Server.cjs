'use strict';

/**
 * Boots an MCP server from a catalog and a meadow client, then serves it over a
 * transport. Dynamic-imports the (ESM-only) MCP SDK so this stays a normal
 * CommonJS Retold module. It knows MCP and the catalog shape; it knows nothing
 * about any application's entities -- those live in the catalog.
 *
 * Catalog shape:
 *   {
 *     Name, Version,
 *     Tools:     [ { Name, Description, InputSchema, Gate?, run(pClient, pArgs) } ],
 *     Resources: [ { Name, Template, run(pClient, pURI, pVariables) } ],
 *     Prompts:   [ { Name, Description, ArgsSchema?, run(pArgs) } ],
 *     allows(pGateKey)   // optional; return false to withhold a gated tool
 *   }
 *
 * The MCP SDK's high-level tool/resource/prompt registration signatures have
 * shifted across SDK versions. Pin @modelcontextprotocol/sdk and confirm the
 * three register calls below against the installed version.
 */
class RetoldMCPServer
{
	constructor(pClient, pCatalog)
	{
		this.Client = pClient;
		this.Catalog = pCatalog || {};
	}

	_allows(pGateKey)
	{
		if (!pGateKey)
		{
			return true;
		}
		if (typeof this.Catalog.allows !== 'function')
		{
			return true;
		}
		return !!this.Catalog.allows(pGateKey);
	}

	_text(pValue)
	{
		let tmpText = (typeof pValue === 'string') ? pValue : JSON.stringify(pValue, null, 2);
		return { content: [{ type: 'text', text: tmpText }] };
	}

	// Build an McpServer from the catalog. pClient is the meadow client the tools/resources act as; it
	// defaults to this.Client (the one-token process edge). The HTTP host passes a per-request client when
	// it wants each session to act as its own bearer token (the multi-tenant edge).
	async _build(pClient)
	{
		let tmpClient = pClient || this.Client;
		let libMCP = await import('@modelcontextprotocol/sdk/server/mcp.js');
		let tmpServer = new libMCP.McpServer(
			{
				name: this.Catalog.Name || 'retold',
				version: this.Catalog.Version || '0.0.1'
			});

		let tmpTools = this.Catalog.Tools || [];
		for (let i = 0; i < tmpTools.length; i++)
		{
			let tmpTool = tmpTools[i];
			if (!this._allows(tmpTool.Gate))
			{
				continue;
			}
			tmpServer.tool(
				tmpTool.Name,
				tmpTool.Description || '',
				tmpTool.InputSchema || {},
				async (pArgs) =>
				{
					try
					{
						return this._text(await tmpTool.run(tmpClient, pArgs || {}));
					}
					catch (pError)
					{
						let tmpMessage = (pError && pError.message) ? pError.message : String(pError);
						return { isError: true, content: [{ type: 'text', text: tmpMessage }] };
					}
				});
		}

		let tmpResources = this.Catalog.Resources || [];
		for (let i = 0; i < tmpResources.length; i++)
		{
			let tmpResource = tmpResources[i];
			tmpServer.resource(
				tmpResource.Name,
				tmpResource.Template,
				async (pURI, pVariables) =>
				{
					let tmpValue = await tmpResource.run(tmpClient, pURI, pVariables || {});
					let tmpText = (typeof tmpValue === 'string') ? tmpValue : JSON.stringify(tmpValue, null, 2);
					return { contents: [{ uri: pURI.href, text: tmpText }] };
				});
		}

		let tmpPrompts = this.Catalog.Prompts || [];
		for (let i = 0; i < tmpPrompts.length; i++)
		{
			let tmpPrompt = tmpPrompts[i];
			tmpServer.prompt(
				tmpPrompt.Name,
				tmpPrompt.Description || '',
				tmpPrompt.ArgsSchema || {},
				async (pArgs) => tmpPrompt.run(pArgs || {}));
		}

		return tmpServer;
	}

	async serveStdio()
	{
		let libStdio = await import('@modelcontextprotocol/sdk/server/stdio.js');
		let tmpServer = await this._build();
		await tmpServer.connect(new libStdio.StdioServerTransport());
		return tmpServer;
	}

	// The hosted edge: a streamable-HTTP listener on pPort, behind nginx, calling the meadow API over
	// loopback. One MCP session per `mcp-session-id`: an `initialize` POST opens one (the transport mints
	// the id and returns it in the response header), later POST/GET/DELETE route to it, and it is dropped
	// on close. Auth is the bearer token the tools carry to /1.0 -- by default the one this server was
	// built with; pass pOptions.clientForRequest(req) to act as a per-request token instead.
	//
	//   pOptions: { Host?, clientForRequest?(pRequest) -> meadowClient, authenticateRequest?(pRequest) -> {ok, wwwAuthenticate?} }
	async serveHTTP(pPort, pOptions)
	{
		let tmpOptions = pOptions || {};
		let libHTTP = require('http');
		let libCrypto = require('crypto');
		let libStreamable = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

		let tmpSessions = {};
		let fClientForRequest = (typeof tmpOptions.clientForRequest === 'function') ? tmpOptions.clientForRequest : (() => this.Client);
		// Optional auth gate. Protocol-generic: the host supplies authenticateRequest(req) that validates the
		// bearer (for plansheet, audience-bound OAuth introspection). It returns { ok, wwwAuthenticate? }; on
		// failure we emit an OAuth 401 challenge so an MCP client discovers the authorization server (RFC 9728).
		let fAuthenticateRequest = (typeof tmpOptions.authenticateRequest === 'function') ? tmpOptions.authenticateRequest : null;

		let fReadBody = (pRequest) => new Promise((resolve) =>
		{
			let tmpChunks = [];
			pRequest.on('data', (pChunk) => tmpChunks.push(pChunk));
			pRequest.on('end', () =>
			{
				let tmpRaw = Buffer.concat(tmpChunks).toString('utf8');
				if (!tmpRaw) { return resolve(undefined); }
				try { resolve(JSON.parse(tmpRaw)); } catch (pError) { resolve(undefined); }
			});
			pRequest.on('error', () => resolve(undefined));
		});

		let fIsInitialize = (pBody) =>
		{
			if (!pBody) { return false; }
			if (Array.isArray(pBody)) { return pBody.some((pMessage) => pMessage && pMessage.method === 'initialize'); }
			return pBody.method === 'initialize';
		};

		let tmpHTTPServer = libHTTP.createServer(async (pRequest, pResponse) =>
		{
			try
			{
				// A dead-simple health probe for nginx + uptime checks (matched with or without the /mcp prefix).
				if (pRequest.method === 'GET' && /\/healthz$/.test((pRequest.url || '').split('?')[0]))
				{
					pResponse.writeHead(200, { 'Content-Type': 'text/plain' });
					return pResponse.end('ok');
				}

				// Auth gate (every MCP request, including the initial `initialize` probe -- the client
				// expects a 401 challenge, runs OAuth, then retries with a token).
				if (fAuthenticateRequest)
				{
					let tmpAuth = await fAuthenticateRequest(pRequest);
					if (!tmpAuth || !tmpAuth.ok)
					{
						let tmpHeaders = { 'Content-Type': 'application/json' };
						if (tmpAuth && tmpAuth.wwwAuthenticate) { tmpHeaders['WWW-Authenticate'] = tmpAuth.wwwAuthenticate; }
						pResponse.writeHead(401, tmpHeaders);
						return pResponse.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required.' }, id: null }));
					}
				}

				let tmpSessionID = pRequest.headers['mcp-session-id'];
				let tmpBody = (pRequest.method === 'POST') ? await fReadBody(pRequest) : undefined;
				let tmpEntry = tmpSessionID ? tmpSessions[tmpSessionID] : null;

				if (!tmpEntry)
				{
					// No live session: only an `initialize` POST may open one.
					if (pRequest.method !== 'POST' || !fIsInitialize(tmpBody))
					{
						pResponse.writeHead(400, { 'Content-Type': 'application/json' });
						return pResponse.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null }));
					}

					tmpEntry = {};
					let tmpTransport = new libStreamable.StreamableHTTPServerTransport(
						{
							sessionIdGenerator: () => libCrypto.randomUUID(),
							onsessioninitialized: (pSID) => { tmpSessions[pSID] = tmpEntry; }
						});
					tmpTransport.onclose = () => { if (tmpTransport.sessionId) { delete tmpSessions[tmpTransport.sessionId]; } };
					let tmpServer = await this._build(fClientForRequest(pRequest));
					tmpEntry.transport = tmpTransport;
					tmpEntry.server = tmpServer;
					await tmpServer.connect(tmpTransport);
				}

				await tmpEntry.transport.handleRequest(pRequest, pResponse, tmpBody);
			}
			catch (pError)
			{
				if (!pResponse.headersSent)
				{
					pResponse.writeHead(500, { 'Content-Type': 'application/json' });
					pResponse.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (pError && pError.message) || String(pError) }, id: null }));
				}
			}
		});

		await new Promise((resolve) => tmpHTTPServer.listen(pPort, tmpOptions.Host || '127.0.0.1', resolve));
		return tmpHTTPServer;
	}
}

module.exports = RetoldMCPServer;
