// KPI card - big number, uppercase label, optional sub-line - ported from the forked dashboard.
import type { ReactNode } from "react";

export function KpiCard({
	label,
	value,
	sub,
	accent = false,
}: {
	label: string;
	value: string;
	sub?: ReactNode;
	/** Highlights the card with the accent color: the page's headline figure. */
	accent?: boolean;
}) {
	return (
		<section
			aria-label={label}
			style={{
				flex: "1 1 180px",
				minWidth: 0,
				background: "var(--color-surface)",
				border: accent
					? "1px solid rgba(139,92,246,0.35)"
					: "1px solid var(--color-border)",
				borderRadius: "var(--radius-lg)",
				padding: "1.25rem 1.5rem",
				position: "relative",
				overflow: "hidden",
			}}
		>
			{accent && (
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: 2,
						background: "var(--color-accent-light)",
					}}
				/>
			)}
			<div
				style={{
					fontSize: "0.7rem",
					fontWeight: 700,
					letterSpacing: "0.08em",
					textTransform: "uppercase",
					color: accent
						? "var(--color-accent-light)"
						: "var(--color-text-subtle)",
					marginBottom: "0.5rem",
				}}
			>
				{label}
			</div>
			<div
				className="tabular-nums"
				style={{
					fontSize: "2rem",
					fontWeight: 700,
					lineHeight: 1.1,
					color: "var(--color-text)",
					letterSpacing: "-0.02em",
					fontFamily: "var(--font-mono)",
				}}
			>
				{value}
			</div>
			{sub && (
				<div
					style={{
						marginTop: "0.375rem",
						fontSize: "0.75rem",
						color: "var(--color-text-subtle)",
					}}
				>
					{sub}
				</div>
			)}
		</section>
	);
}
