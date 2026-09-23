// Top-of-page KPI row, ported from the forked dashboard's per-person KPIs: one headline cost
// tile plus responses and tokens. Every figure is notional, so there's no billed/subscription
// pair of tiles and no previous-period delta badge.
import { KpiCard } from "../components/KpiCard";
import { formatCurrency, formatInt, formatTokens } from "../lib/formatters";
import type { WindowTotals } from "../lib/modelStacks";

export function UsageKpis({
	totals,
	windowLabel,
}: {
	totals: WindowTotals;
	windowLabel: string;
}) {
	return (
		<div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
			<KpiCard
				accent
				label="Notional Cost"
				value={formatCurrency(totals.notionalCost)}
				sub={`${windowLabel} · tokens x published rates`}
			/>
			<KpiCard
				label="Responses"
				value={formatInt(totals.responses)}
				sub={windowLabel}
			/>
			<KpiCard
				label="Total Tokens"
				value={formatTokens(totals.tokens)}
				sub={windowLabel}
			/>
		</div>
	);
}
