// The one warning we drop while importing node:sqlite.
//
// node:sqlite prints an ExperimentalWarning on import in Node 22.x. Whether it prints at all
// depends on the Node version, so the decision and the wrapper live here where tests call them
// directly, instead of relying on the import to emit the warning.

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
