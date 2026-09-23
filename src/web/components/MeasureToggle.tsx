// Segmented control, ported from the forked dashboard's measure toggle. Generic over its options,
// so the same control serves Cost | Tokens and the chart's Total | By model switch.

export interface ToggleOption<T extends string> {
	value: T;
	label: string;
}

export const MEASURE_OPTIONS: ToggleOption<"cost" | "tokens">[] = [
	{ value: "cost", label: "Cost" },
	{ value: "tokens", label: "Tokens" },
];

export function MeasureToggle<T extends string>({
	value,
	onChange,
	options,
	label,
}: {
	value: T;
	onChange: (next: T) => void;
	options: ToggleOption<T>[];
	/** The group's accessible name, e.g. "Measure". */
	label: string;
}) {
	return (
		// A fieldset: the native element for a group of controls (implicit role "group").
		<fieldset
			aria-label={label}
			style={{
				display: "flex",
				margin: 0,
				minWidth: 0,
				border: "none",
				gap: "0.25rem",
				background: "var(--color-surface-2)",
				padding: "0.15rem",
				borderRadius: "var(--radius-md)",
			}}
		>
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => onChange(opt.value)}
					aria-pressed={value === opt.value}
					style={{
						padding: "0.25rem 0.6rem",
						fontSize: "0.7rem",
						fontWeight: 500,
						fontFamily: "var(--font-sans)",
						background:
							value === opt.value ? "var(--color-accent)" : "transparent",
						color: value === opt.value ? "#fff" : "var(--color-text-muted)",
						border: "none",
						borderRadius: "var(--radius-sm)",
						cursor: "pointer",
						textTransform: "uppercase",
						letterSpacing: "0.05em",
						transition: "background 150ms ease-out, color 150ms ease-out",
					}}
				>
					{opt.label}
				</button>
			))}
		</fieldset>
	);
}
