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
		// Structured logger, replaced by serveHTTP with the host-supplied one (or its stdout default). The
		// stdio transport keeps this stderr default so a tool failure there is still visible.
		this._log = (pLevel, pEvent, pFields) =>
		{
			let tmpText = 'mcp ' + JSON.stringify(Object.assign({ level: pLevel, event: pEvent, time: new Date().toISOString() }, pFields || {}));
			process.stderr.write(tmpText + '\n');
		};
		this._debug = /^(1|true|yes)$/i.test(process.env.RETOLD_MCP_DEBUG || '');
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
						let tmpResult = this._text(await tmpTool.run(tmpClient, pArgs || {}));
						if (this._debug) { this._log('debug', 'tool_ok', { tool: tmpTool.Name }); }
						return tmpResult;
					}
					catch (pError)
					{
						let tmpMessage = (pError && pError.message) ? pError.message : String(pError);
						this._log('warn', 'tool_error', { tool: tmpTool.Name, message: tmpMessage });
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

		// Structured breadcrumbs for diagnosing a failed connection. Key lifecycle + failure events log by
		// default (warn/error to stderr, info to stdout); per-request detail is gated behind RETOLD_MCP_DEBUG
		// so normal operation is not noisy. The host may inject its own Log(level, event, fields) via options.
		let fLog = (typeof tmpOptions.Log === 'function') ? tmpOptions.Log : ((pLevel, pEvent, pFields) =>
		{
			let tmpLine = Object.assign({ level: pLevel, event: pEvent, time: new Date().toISOString() }, pFields || {});
			let tmpText = 'mcp ' + JSON.stringify(tmpLine);
			if (pLevel === 'error' || pLevel === 'warn') { process.stderr.write(tmpText + '\n'); } else { process.stdout.write(tmpText + '\n'); }
		});
		let tmpDebug = /^(1|true|yes)$/i.test(process.env.RETOLD_MCP_DEBUG || '');
		// Share the resolved logger + debug flag with _build so tool-level failures log in the same stream.
		this._log = fLog; this._debug = tmpDebug;
		// A session id is a per-connection handle, not a bearer secret, but truncate it in logs anyway so a
		// full line is never a copy-pasteable session. Shows enough to correlate a client across requests.
		let fSid = (pSID) => pSID ? (String(pSID).slice(0, 8) + '..[' + String(pSID).length + ']') : '(none)';
		let fPath = (pRequest) => String(pRequest.url || '').split('?')[0];

		// Stateless mode (pOptions.Stateless): no mcp-session-id, a fresh transport + server per request. A
		// recreate-prone edge should use this so a container restart cannot orphan a client's session. Default
		// stays stateful (session-per-connection) so existing consumers are unaffected.
		let tmpStateless = !!tmpOptions.Stateless;
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
				// Not logged: it fires constantly and says nothing about a real connection.
				if (pRequest.method === 'GET' && /\/healthz$/.test((pRequest.url || '').split('?')[0]))
				{
					pResponse.writeHead(200, { 'Content-Type': 'text/plain' });
					return pResponse.end('ok');
				}

				let tmpReqSID = pRequest.headers['mcp-session-id'];
				if (tmpDebug) { fLog('debug', 'request', { method: pRequest.method, path: fPath(pRequest), sid: fSid(tmpReqSID), sessions: Object.keys(tmpSessions).length }); }

				// Auth gate (every MCP request, including the initial `initialize` probe -- the client
				// expects a 401 challenge, runs OAuth, then retries with a token).
				if (fAuthenticateRequest)
				{
					let tmpAuth = await fAuthenticateRequest(pRequest);
					if (!tmpAuth || !tmpAuth.ok)
					{
						// The single most useful auth breadcrumb: WHY the token was refused (missing / inactive /
						// audience mismatch / the introspection call itself failing), plus the audience we expected
						// vs. the one the token carried when those differ.
						fLog('warn', 'auth_reject', { method: pRequest.method, path: fPath(pRequest), sid: fSid(tmpReqSID), reason: (tmpAuth && tmpAuth.reason) || 'unknown', expectedAudience: (tmpAuth && tmpAuth.expectedAudience) || undefined, tokenAudience: (tmpAuth && tmpAuth.tokenAudience) || undefined });
						let tmpHeaders = { 'Content-Type': 'application/json' };
						if (tmpAuth && tmpAuth.wwwAuthenticate) { tmpHeaders['WWW-Authenticate'] = tmpAuth.wwwAuthenticate; }
						pResponse.writeHead(401, tmpHeaders);
						return pResponse.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required.' }, id: null }));
					}
				}

				let tmpSessionID = tmpReqSID;
				let tmpBody = (pRequest.method === 'POST') ? await fReadBody(pRequest) : undefined;

				if (tmpStateless)
				{
					// Stateless: a fresh transport + server per request, torn down when the response ends. Nothing is
					// kept in memory between requests, so a container recreate cannot orphan a client session -- there is
					// none to lose. Suits a request/response catalog with no server-initiated push. Auth still runs on
					// every request above; per-action attribution is recorded durably at the /1.0 API, not edge memory.
					let tmpTransport = new libStreamable.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
					let tmpServer = await this._build(fClientForRequest(pRequest));
					pResponse.on('close', () =>
					{
						try { tmpTransport.close(); } catch (pCloseErr) { /* best effort */ }
						try { tmpServer.close(); } catch (pCloseErr) { /* best effort */ }
					});
					await tmpServer.connect(tmpTransport);
					return tmpTransport.handleRequest(pRequest, pResponse, tmpBody);
				}
				let tmpEntry = tmpSessionID ? tmpSessions[tmpSessionID] : null;

				if (!tmpEntry)
				{
					// No live session: only an `initialize` POST may open one.
					if (pRequest.method !== 'POST' || !fIsInitialize(tmpBody))
					{
						// THE breadcrumb for "the connector's server isn't responding" after a container recreate:
						// the client presents a session id this process has never seen. activeSessions=0 right after a
						// deploy means the in-memory session table was wiped and the client must re-initialize.
						fLog('warn', 'session_unknown', { method: pRequest.method, path: fPath(pRequest), sid: fSid(tmpSessionID), activeSessions: Object.keys(tmpSessions).length });
						pResponse.writeHead(400, { 'Content-Type': 'application/json' });
						return pResponse.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null }));
					}

					tmpEntry = {};
					let tmpTransport = new libStreamable.StreamableHTTPServerTransport(
						{
							sessionIdGenerator: () => libCrypto.randomUUID(),
							onsessioninitialized: (pSID) => { tmpSessions[pSID] = tmpEntry; fLog('info', 'session_open', { sid: fSid(pSID), activeSessions: Object.keys(tmpSessions).length }); }
						});
					tmpTransport.onclose = () => { if (tmpTransport.sessionId) { delete tmpSessions[tmpTransport.sessionId]; fLog('info', 'session_close', { sid: fSid(tmpTransport.sessionId), activeSessions: Object.keys(tmpSessions).length }); } };
					let tmpServer = await this._build(fClientForRequest(pRequest));
					tmpEntry.transport = tmpTransport;
					tmpEntry.server = tmpServer;
					await tmpServer.connect(tmpTransport);
				}

				await tmpEntry.transport.handleRequest(pRequest, pResponse, tmpBody);
			}
			catch (pError)
			{
				// Previously swallowed into a bare 500. Now the stack lands in the logs so a transport or
				// dispatch failure is diagnosable instead of an opaque "server isn't responding".
				fLog('error', 'handler_error', { method: pRequest && pRequest.method, path: pRequest ? fPath(pRequest) : '', message: (pError && pError.message) || String(pError), stack: (pError && pError.stack) || undefined });
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
