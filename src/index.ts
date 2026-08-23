/**
 * pi-janus entrypoint: load config, start the server, handle shutdown.
 * Runs only when executed directly (the compiled binary or `bun run src/index.ts`).
 */

import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const handle = await createServer(config);
	console.log(`pi-janus listening on http://${config.host}:${handle.port} (faux=${config.faux})`);

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`${signal} received, shutting down...`);
		await handle.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
