'use strict';

/**
 * The engine knows MCP + meadow conventions and nothing about any application's
 * entities. These guard the two seams that matter without standing up a network
 * or importing the ESM SDK: the meadow route surface, and the catalog gate that
 * decides which tools a caller may see.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libRetoldMCPMeadowClient = require('../source/Retold-MCP-MeadowClient.cjs');
const libRetoldMCPServer = require('../source/Retold-MCP-Server.cjs');

suite('Retold MCP engine', function ()
{
	suite('Meadow client', function ()
	{
		test('trims the base URL and exposes the meadow route surface', function ()
		{
			let tmpClient = new libRetoldMCPMeadowClient({ URL: 'https://example.test/', Token: 'pls_x' });
			Expect(tmpClient.URL).to.equal('https://example.test');
			Expect(tmpClient.Version).to.equal('1.0');
			['read', 'reads', 'create', 'update', 'destroy', 'count', 'schema', 'get', 'post', 'put'].forEach((pName) =>
			{
				Expect(tmpClient[pName], pName).to.be.a('function');
			});
		});
	});

	suite('Server catalog gating', function ()
	{
		test('honors the catalog allows() predicate for gated tools', function ()
		{
			let tmpServer = new libRetoldMCPServer(null, { allows: (pKey) => pKey === 'content.view' });
			Expect(tmpServer._allows('content.view')).to.equal(true);
			Expect(tmpServer._allows('content.edit')).to.equal(false);
			Expect(tmpServer._allows(null)).to.equal(true);
		});

		test('allows everything when the catalog defines no predicate', function ()
		{
			let tmpServer = new libRetoldMCPServer(null, {});
			Expect(tmpServer._allows('anything')).to.equal(true);
		});
	});
});
