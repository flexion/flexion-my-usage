// One day's per-model breakdown, opened by clicking a bar (or picking the day in the date
// input). Stands in for the forked dashboard's per-day events drawer: that one listed individual
// requests from a server-side query, while this page only has the day's per-model totals.
import type { DayBucket } from "../../usage-payload";
import { formatCurrency, formatInt, formatTokens } from "../lib/formatters";
import { rankModels } from "../lib/modelStacks";

export function DayDetail({
	day,
	labelFor,
	onClose,
}: {
	day: DayBucket;
	labelFor: (key: string) => string;
	onClose: () => void;
}) {
	const models = rankModels([day]);
	return (
		<section
			aria-label={`Usage on ${day.day}`}
			style={{
				marginTop: "1rem",
				paddingTop: "0.75rem",
				borderTop: "1px solid var(--color-border)",
				fontSize: "0.8125rem",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "baseline",
					gap: "1rem",
					marginBottom: "0.5rem",
				}}
			>
				<h3 style={{ margin: 0, fontSize: "0.8125rem", fontWeight: 600 }}>
					<span style={{ fontFamily: "var(--font-mono)" }}>{day.day}</span>
					{" - "}
					{formatCurrency(day.notionalCost)}, {formatTokens(day.tokens)} tokens,{" "}
					{formatInt(day.responses)} responses
				</h3>
				<button
					type="button"
					onClick={onClose}
					style={{
						background: "transparent",
						border: "1px solid var(--color-border)",
						borderRadius: "var(--radius-sm)",
						color: "var(--color-text-muted)",
						fontSize: "0.72rem",
						padding: "0.2rem 0.5rem",
						cursor: "pointer",
					}}
				>
					Close
				</button>
			</div>
			{models.length === 0 ? (
				<p style={{ margin: 0, color: "var(--color-text-subtle)" }}>
					No usage on this day.
				</p>
			) : (
				<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
					{models.map((row) => (
						<li
							key={row.key}
							style={{
								display: "flex",
								alignItems: "center",
								gap: "0.75rem",
								padding: "0.15rem 0",
							}}
						>
							<span
								style={{
									flex: 1,
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									fontFamily: "var(--font-mono)",
									color: "var(--color-text-muted)",
								}}
							>
								{labelFor(row.key)}
							</span>
							<span className="tabular-nums">
								{formatTokens(row.tokens)} tokens
							</span>
							<span
								className="tabular-nums"
								style={{
									fontWeight: 600,
									minWidth: "5rem",
									textAlign: "right",
								}}
							>
								{formatCurrency(row.notionalCost)}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
