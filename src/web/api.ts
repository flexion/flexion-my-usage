// The page's one request: the usage payload from the data route (see server.ts).
import { DATA_PATH, type UsagePayload } from "../usage-payload";

/** Fetches the payload; rejects on a non-2xx status, naming it, rather than parsing an error page. */
export async function loadUsage(
	fetchImpl: (url: string) => Promise<Response>,
): Promise<UsagePayload> {
	const res = await fetchImpl(DATA_PATH);
	if (!res.ok) {
		throw new Error(`couldn't load usage data (HTTP ${res.status})`);
	}
	return (await res.json()) as UsagePayload;
}
