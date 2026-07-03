'use strict';

/**
 * A thin client for a meadow-endpoints REST API.
 *
 * It knows the route conventions (pluralized list, /Entity/:id read, POST create,
 * PUT update) and /Schema discovery, carries a bearer token, and does nothing
 * application-specific -- no entity names live here. The catalog layer composes
 * these calls into application tools.
 */
class RetoldMCPMeadowClient
{
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.URL = String(tmpOptions.URL || '').replace(/\/+$/, '');
		this.Token = tmpOptions.Token || '';
		this.Version = tmpOptions.Version || '1.0';
		this._SchemaCache = {};
	}

	async _request(pMethod, pPath, pBody)
	{
		let tmpURL = `${this.URL}/${this.Version}/${pPath}`;
		let tmpHeaders = { 'Content-Type': 'application/json' };
		if (this.Token)
		{
			tmpHeaders['Authorization'] = `Bearer ${this.Token}`;
		}
		let tmpResponse = await fetch(tmpURL,
			{
				method: pMethod,
				headers: tmpHeaders,
				body: (pBody == null) ? undefined : JSON.stringify(pBody)
			});
		if (!tmpResponse.ok)
		{
			let tmpText = await tmpResponse.text().catch(() => '');
			throw new Error(`retold-mcp ${pMethod} ${tmpURL} -> ${tmpResponse.status} ${tmpText.slice(0, 240)}`);
		}
		if (tmpResponse.status === 204)
		{
			return null;
		}
		return tmpResponse.json();
	}

	// meadow-endpoints route conventions. NOTE: the list route is pluralized with
	// a naive trailing 's' (Vision -> Visions), matching meadow's own pluralizer.
	read(pEntity, pID)             { return this._request('GET', `${pEntity}/${pID}`); }
	reads(pEntity, pBegin, pCap)   { return this._request('GET', `${pEntity}s/${pBegin || 0}/${pCap || 100}`); }
	create(pEntity, pRecord)       { return this._request('POST', pEntity, pRecord); }
	update(pEntity, pID, pRecord)  { return this._request('PUT', `${pEntity}/${pID}`, pRecord); }
	destroy(pEntity, pID)          { return this._request('DELETE', `${pEntity}/${pID}`); }
	count(pEntity)                 { return this._request('GET', `${pEntity}/Count`); }

	// JSONSchema discovery, so the engine can build tool input schemas without
	// hardcoding any application's field shapes. Cached per entity.
	async schema(pEntity)
	{
		if (!this._SchemaCache[pEntity])
		{
			this._SchemaCache[pEntity] = await this._request('GET', `${pEntity}/Schema`);
		}
		return this._SchemaCache[pEntity];
	}

	// Escape hatches for the custom routes a catalog needs (boards, /Account/Me, ...).
	get(pPath)             { return this._request('GET', pPath); }
	post(pPath, pBody)     { return this._request('POST', pPath, pBody); }
	put(pPath, pBody)      { return this._request('PUT', pPath, pBody); }
}

module.exports = RetoldMCPMeadowClient;
