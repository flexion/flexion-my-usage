// The page: fetch the usage payload once, then lay out the ported sections - KPI row, daily
// chart, per-model table - in the forked dashboard's per-person page order.
import { useEffect, useState } from "react";
import type { SkippedDatabases, UsagePayload } from "../usage-payload";
import { SkeletonChart, SkeletonKpiRow } from "./components/Skeleton";
import { modelLabeler, rankModels, windowTotals } from "./lib/modelStacks";
import { DailyCostSection } from "./views/DailyCostSection";
import { ModelTableSection } from "./views/ModelTableSection";
import { UsageKpis } from "./views/UsageKpis";

type State =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; payload: UsagePayload };

/** An Error's own message, or anything else as text. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Names how many discovered databases failed to read, or nothing when none did. Count-only on
 * purpose: which database failed, and why, already went to the terminal, and a failed database
 * contributes no rows, so there is nothing to flag per day.
 */
function SkipNote({ skipped }: { skipped: SkippedDatabases }) {
	if (skipped.skipped === 0) return null;
	return (
		<p
			role="status"
			style={{
				margin: 0,
				padding: "0.625rem 0.875rem",
				background: "var(--color-warning-bg)",
				border: "1px solid var(--color-warning)",
				borderRadius: "var(--radius-lg)",
				fontSize: "0.8125rem",
			}}
		>
			{skipped.skipped} of {skipped.total} databases could not be read - see
			terminal for details.
		</p>
	);
}

function Dashboard({ payload }: { payload: UsagePayload }) {
	const { days, skipped } = payload;
	const windowLabel = `Last ${days.length} days`;
	const labelFor = modelLabeler(days);
	return (
		<>
			<SkipNote skipped={skipped} />
			<UsageKpis totals={windowTotals(days)} windowLabel={windowLabel} />
			<DailyCostSection days={days} labelFor={labelFor} />
			<ModelTableSection models={rankModels(days)} labelFor={labelFor} />
		</>
	);
}

function Body({ state }: { state: State }) {
	if (state.status === "loading") {
		return (
			<section aria-busy="true" aria-label="Loading usage">
				<SkeletonKpiRow />
				<div style={{ marginTop: "1.25rem" }}>
					<SkeletonChart />
				</div>
			</section>
		);
	}
	if (state.status === "error") {
		return (
			<p
				role="alert"
				style={{
					margin: 0,
					padding: "0.625rem 0.875rem",
					background: "var(--color-error-bg)",
					border: "1px solid var(--color-error)",
					borderRadius: "var(--radius-lg)",
				}}
			>
				{state.message} - is the my-usage process still running?
			</p>
		);
	}
	return <Dashboard payload={state.payload} />;
}

export function App({ load }: { load: () => Promise<UsagePayload> }) {
	const [state, setState] = useState<State>({ status: "loading" });
	useEffect(() => {
		load().then(
			(payload) => setState({ status: "ready", payload }),
			(error: unknown) =>
				setState({ status: "error", message: errorText(error) }),
		);
	}, [load]);
	return (
		<main
			style={{
				maxWidth: 1100,
				margin: "0 auto",
				padding: "1.5rem 1rem 3rem",
				display: "flex",
				flexDirection: "column",
				gap: "1.25rem",
			}}
		>
			<header>
				<h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>
					my-usage
				</h1>
				<p
					style={{
						margin: "0.25rem 0 0",
						fontSize: "0.8125rem",
						color: "var(--color-text-subtle)",
					}}
				>
					Your opencode usage, read from this machine and priced at published
					rates. Nothing leaves it.
				</p>
			</header>
			<Body state={state} />
		</main>
	);
}
