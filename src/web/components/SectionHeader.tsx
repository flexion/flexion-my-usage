// Section title with an optional caption beside it, ported from the forked dashboard. Its "open
// in" spoke link pointed at other views of that dashboard; this page is a single view, so the
// link didn't come across.
import type { ReactNode } from "react";

export function SectionHeader({
	title,
	caption,
}: {
	title: ReactNode;
	caption?: ReactNode;
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "baseline",
				gap: "0.5rem",
				flexWrap: "wrap",
			}}
		>
			<h2
				style={{
					margin: 0,
					fontSize: "0.875rem",
					fontWeight: 600,
					color: "var(--color-text)",
					letterSpacing: "0.01em",
				}}
			>
				{title}
			</h2>
			{caption}
		</div>
	);
}
