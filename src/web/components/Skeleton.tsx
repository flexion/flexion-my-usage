// Loading placeholders - a pulsing block, no shimmer - ported from the forked dashboard. The
// pulse keyframes live in index.css rather than being injected at import time.
import type { CSSProperties } from "react";

export function Skeleton({
	width = "100%",
	height = "1rem",
	style,
}: {
	width?: string;
	height?: string;
	style?: CSSProperties;
}) {
	return (
		<div
			style={{
				width,
				height,
				borderRadius: "var(--radius-md)",
				background: "var(--color-surface-2)",
				animation: "pulse 1.5s ease-in-out infinite",
				...style,
			}}
		/>
	);
}

export function SkeletonKpiRow() {
	return (
		<div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
			{[0, 1, 2].map((i) => (
				<div
					key={i}
					style={{
						flex: "1 1 180px",
						background: "var(--color-surface)",
						border: "1px solid var(--color-border)",
						borderRadius: "var(--radius-lg)",
						padding: "1.25rem 1.5rem",
					}}
				>
					<Skeleton
						width="60%"
						height="0.7rem"
						style={{ marginBottom: "0.75rem" }}
					/>
					<Skeleton width="80%" height="2rem" />
				</div>
			))}
		</div>
	);
}

export function SkeletonChart({ height = 240 }: { height?: number }) {
	return (
		<Skeleton
			height={`${height}px`}
			style={{ borderRadius: "var(--radius-lg)" }}
		/>
	);
}
