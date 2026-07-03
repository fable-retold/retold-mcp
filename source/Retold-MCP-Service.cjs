'use strict';

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libRetoldMCPMeadowClient = require('./Retold-MCP-MeadowClient.cjs');
const libRetoldMCPServer = require('./Retold-MCP-Server.cjs');

/**
 * Retold MCP engine, as a Fable service.
 *
 * Give it a meadow-endpoints URL plus a bearer token, register a catalog, and it
 * serves that catalog to AI agents over MCP. The catalog (which entities, the
 * composite tools, the prompts, the entitlement gate) is application-specific and
 * lives in a separate package that depends on this one. See plansheet-mcp.
 *
 *   const libRetoldMCP = require('retold-mcp');
 *   let tmpMCP = new libRetoldMCP(pFable, { URL: 'https://plansheet.io', Token: process.env.PLANSHEET_TOKEN });
 *   tmpMCP.registerCatalog(require('./Plansheet-Catalog.js')(tmpMCP.client));
 *   await tmpMCP.serveStdio();
 */
class RetoldMCPService extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'RetoldMCP';
		this.options = Object.assign(
			{
				URL: '',
				Token: '',
				Version: '1.0'
			}, this.options || {});
		this.client = new libRetoldMCPMeadowClient(this.options);
		this.catalog = null;
		this._server = null;
	}

	registerCatalog(pCatalog)
	{
		this.catalog = pCatalog;
		this._server = new libRetoldMCPServer(this.client, pCatalog);
		return this;
	}

	serveStdio()
	{
		if (!this._server)
		{
			throw new Error('RetoldMCP: registerCatalog(...) before serving.');
		}
		return this._server.serveStdio();
	}

	serveHTTP(pPort, pOptions)
	{
		if (!this._server)
		{
			throw new Error('RetoldMCP: registerCatalog(...) before serving.');
		}
		return this._server.serveHTTP(pPort, pOptions);
	}
}

module.exports = RetoldMCPService;
// The inner classes are plain (no Fable), so a standalone CLI (a stdio server, a
// hook) can use them directly without standing up a Fable instance.
module.exports.Server = libRetoldMCPServer;
module.exports.MeadowClient = libRetoldMCPMeadowClient;
