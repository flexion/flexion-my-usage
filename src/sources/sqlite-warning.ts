// The one warning we drop while importing node:sqlite.
//
// node:sqlite prints an ExperimentalWarning on import in Node 22.x. Whether it prints at all
// depends on the Node version, so the decision, the wrapper and the install/restore around a
// load live here where tests call them directly with a fake loader, instead of relying on the
// import to emit the warning.

/** True only for Node's "SQLite is an experimental feature" ExperimentalWarning. */
export function isSqliteExperimentalWarning(
	warning: string | Error,
	args: unknown[],
): boolean {
	const message = typeof warning === "string" ? warning : warning.message;
	const options = args[0];
	const type =
		typeof options === "string"
			? options
			: typeof options === "object" && options !== null
				? (options as { type?: string }).type
				: typeof warning === "string"
					? undefined
					: warning.name;
	return (
		type === "ExperimentalWarning" &&
		message.startsWith("SQLite is an experimental feature")
	);
}

/** An `emitWarning` that drops the SQLite experimental warning and forwards everything else. */
export function withoutSqliteWarning(
	original: typeof process.emitWarning,
): typeof process.emitWarning {
	return ((warning: string | Error, ...args: unknown[]) => {
		if (isSqliteExperimentalWarning(warning, args)) return;
		return (original as (...a: unknown[]) => void).call(
			process,
			warning,
			...args,
		);
	}) as typeof process.emitWarning;
}

// Set for the duration of one withSqliteWarningSuppressed call, so a second, overlapping call
// fails loudly instead of silently restoring process.emitWarning in the wrong order.
let inFlight = false;

/**
 * Runs `load` with the SQLite experimental warning dropped, then puts `process.emitWarning`
 * back exactly as it was, whether `load` resolves or rejects. Not re-entrant: two overlapping
 * calls would restore in the wrong order, so callers load once and share the result (see
 * opencode.ts's `sqlite ??=`). The `inFlight` guard above turns a would-be second caller into a
 * thrown error instead of a silently corrupted `process.emitWarning`.
 */
export async function withSqliteWarningSuppressed<T>(
	load: () => Promise<T>,
): Promise<T> {
	if (inFlight) {
		throw new Error(
			"withSqliteWarningSuppressed is not re-entrant: a call is already in flight. " +
				"Callers must load once and share the result instead of calling concurrently.",
		);
	}
	inFlight = true;
	const original = process.emitWarning;
	process.emitWarning = withoutSqliteWarning(original);
	try {
		return await load();
	} finally {
		process.emitWarning = original;
		inFlight = false;
	}
}
