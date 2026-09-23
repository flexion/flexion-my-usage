// The browser entry point: mounts App with the real fetch. Wiring only - excluded from the
// coverage gate as a humble object (vitest.config.ts) and held branch-free by
// scripts/branch-guard.ts, the same way src/index.ts is on the Node side.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadUsage } from "./api";
import "./index.css";

const load = () => loadUsage((url) => fetch(url));

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App load={load} />
	</StrictMode>,
);
