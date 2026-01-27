import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const appName = process.env.APP_NAME || "token-browser";
const appRoot = resolve(__dirname, `src/apps/${appName}/ui`);

export default defineConfig({
	root: appRoot,
	plugins: [viteSingleFile()],
	build: {
		outDir: resolve(__dirname, `dist/apps/${appName}`),
		emptyOutDir: false,
		rollupOptions: {
			input: resolve(appRoot, "mcp-app.html"),
		},
	},
});
