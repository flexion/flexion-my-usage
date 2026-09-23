// Number formatters for the page, ported from the forked dashboard's own. Every one is total:
// NaN (or anything else non-finite that `Number(n) || 0` folds away) formats as zero, never as
// "NaN".

/**
 * A dollar amount. Small values (< $0.01) show 4 decimal places; everything else shows 2.
 * e.g. "$12.34" or "$0.0045".
 */
export function formatCurrency(n: number): string {
	const v = Number(n) || 0;
	if (v === 0) return "$0.00";
	if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
	return `$${v.toFixed(2)}`;
}

/**
 * A token count with k/M/B suffixes; under 1k, a rounded integer. e.g. "7.06B", "1.20M",
 * "42.0k", "999".
 */
export function formatTokens(n: number): string {
	const v = Number(n) || 0;
	if (v === 0) return "0";
	const abs = Math.abs(v);
	if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
	return String(Math.round(v));
}

/**
 * An integer with thousands separators, e.g. "1,234,567". Pinned to en-US rather than the
 * browser's locale (the one change from the forked dashboard's version) so the separators
 * match the dollar and token figures beside it, which are never localized.
 */
export function formatInt(n: number): string {
	return (Number(n) || 0).toLocaleString("en-US");
}
