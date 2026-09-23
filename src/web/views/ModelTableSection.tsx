// Per-model table for the window, ported from the forked dashboard's By Model section. Its
// cost-composition bar and previous-period delta need per-bucket token splits and a comparison
// period the data route doesn't carry, so the row here is model, tokens, share and notional
// cost - with the same "not real spend" badge treatment that dashboard gave subscription rows,
// reused for models no published rate covered.
import type { CSSProperties } from "react";
import { Card } from "../components/Card";
import { SectionHeader } from "../components/SectionHeader";
import { formatCurrency, formatTokens } from "../lib/formatters";
import type { ModelRow } from "../lib/modelStacks";

const TH: CSSProperties = {
	padding: "0.5rem 0.75rem",
	fontSize: "0.68rem",
	fontWeight: 600,
	letterSpacing: "0.06em",
	textTransform: "uppercase",
	color: "var(--color-text-subtle)",
	borderBottom: "1px solid var(--color-border)",
	textAlign: "right",
};

const TD: CSSProperties = {
	padding: "0.55rem 0.75rem",
	borderBottom: "1px solid var(--color-border)",
	fontFamily: "var(--font-mono)",
	fontSize: "0.8125rem",
	textAlign: "right",
};

/** `part` as a percentage of `whole`, one decimal; "-" when there's no whole to divide. */
export function sharePct(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-";
}

export function ModelTableSection({
	models,
	labelFor,
}: {
	/** Ranked, largest cost first (see rankModels). */
	models: ModelRow[];
	labelFor: (key: string) => string;
}) {
	const totalCost = models.reduce((sum, row) => sum + row.notionalCost, 0);
	return (
		<Card label="By model" style={{ padding: 0, overflow: "hidden" }}>
			<div style={{ padding: "1.25rem 1.5rem 0.5rem" }}>
				<SectionHeader title="By Model" />
				<p
					style={{
						margin: "0.25rem 0 0",
						fontSize: "0.75rem",
						color: "var(--color-text-subtle)",
					}}
				>
					Notional cost per model over the window. Models marked "no rate" have
					no published price, so their tokens count but their cost reads $0.
				</p>
			</div>
			{models.length === 0 ? (
				<p
					style={{
						margin: 0,
						padding: "0 1.5rem 1.25rem",
						color: "var(--color-text-subtle)",
						fontSize: "0.8125rem",
					}}
				>
					No usage recorded in this window.
				</p>
			) : (
				<div style={{ overflowX: "auto" }}>
					<table style={{ width: "100%", borderCollapse: "collapse" }}>
						<thead>
							<tr>
								<th style={{ ...TH, textAlign: "left", paddingLeft: "1.5rem" }}>
									Model
								</th>
								<th style={TH}>Tokens</th>
								<th style={TH}>Share</th>
								<th style={{ ...TH, paddingRight: "1.5rem" }}>Notional cost</th>
							</tr>
						</thead>
						<tbody>
							{models.map((row) => (
								<tr key={row.key}>
									<td
										style={{
											...TD,
											textAlign: "left",
											paddingLeft: "1.5rem",
											maxWidth: 320,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{labelFor(row.key)}
										{row.unpricedTokens > 0 && (
											<span
												title={`${formatTokens(row.unpricedTokens)} tokens had no published rate`}
												style={{
													marginLeft: 8,
													fontSize: "0.62rem",
													fontFamily: "var(--font-sans)",
													fontWeight: 600,
													letterSpacing: "0.05em",
													textTransform: "uppercase",
													padding: "1px 6px",
													borderRadius: 4,
													border: "1px solid var(--color-warning)",
													color: "var(--color-warning)",
													verticalAlign: "middle",
												}}
											>
												no rate
											</span>
										)}
									</td>
									<td style={{ ...TD, color: "var(--color-text-muted)" }}>
										{formatTokens(row.tokens)}
									</td>
									<td style={{ ...TD, color: "var(--color-text-muted)" }}>
										{sharePct(row.notionalCost, totalCost)}
									</td>
									<td
										style={{
											...TD,
											paddingRight: "1.5rem",
											color: "var(--color-accent-light)",
											fontWeight: 600,
										}}
									>
										{formatCurrency(row.notionalCost)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}
