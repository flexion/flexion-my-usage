// Card surface and header row, ported from the forked dashboard.
import type { CSSProperties, ReactNode } from "react";

export function Card({
	children,
	style,
	label,
}: {
	children: ReactNode;
	style?: CSSProperties;
	/** Names the card as a landmark region for assistive tech. */
	label?: string;
}) {
	return (
		<section
			aria-label={label}
			style={{
				background: "var(--color-surface)",
				border: "1px solid var(--color-border)",
				borderRadius: "var(--radius-lg)",
				padding: "1.25rem 1.5rem",
				...style,
			}}
		>
			{children}
		</section>
	);
}

export function CardHeader({ children }: { children: ReactNode }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				flexWrap: "wrap",
				gap: "0.75rem",
				marginBottom: "1rem",
			}}
		>
			{children}
		</div>
	);
}
