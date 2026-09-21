// Standalone entrypoint, not a module of helpers: spawned as its own `tsx` subprocess by
// pricing-table.test.ts's real-proxy-body test, so it can run with NODE_EXTRA_CA_CERTS set in
// its OWN environment before Node starts. That variable is read once at Node startup, so
// setting it from inside an already-running test process has no effect - the only way to make
// a client trust the fixture's self-signed TEST_ORIGIN_CERT is to hand it to a fresh process
// (confirmed by hand while building this fixture: an in-process `process.env` assignment right
// before the fetch left the connection failing "self-signed certificate").
//
// Imports the real, unmodified loadPriceTable and calls it exactly like production code would,
// through a real ProxyAgent dispatching to a real local proxy (see pricing.fixtures.ts's
// startTunnelingProxy/startFakeOrigin) - so this test exercises the actual shipped code path,
// not a synthetic stand-in for it.
//
// argv: [proxyUrl, cacheDir, timeoutMs]. Prints one JSON line to stdout: either
// {"table": <entry count>} on success, or {"warned": <message>} if loadPriceTable's own
// warn-and-continue path fired (its normal behavior on any fetch failure, including a timeout).
import { loadPriceTable } from "./pricing-table.js";

const [proxyUrl, cacheDir, timeoutMs] = process.argv.slice(2);
if (!proxyUrl || !cacheDir || !timeoutMs) {
	console.error(
		"usage: load-price-table-via-proxy.fixtures.ts <proxyUrl> <cacheDir> <timeoutMs>",
	);
	process.exit(2);
}

let warned: string | undefined;
const table = await loadPriceTable(
	{
		cacheDir,
		timeoutMs: Number(timeoutMs),
		env: { HTTPS_PROXY: proxyUrl },
	},
	(message) => {
		warned = message;
	},
);

console.log(JSON.stringify(table ? { table: table.size } : { warned }));
