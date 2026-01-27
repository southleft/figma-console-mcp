import { App } from "@modelcontextprotocol/ext-apps";

const timeEl = document.getElementById("time")!;
const statusEl = document.getElementById("status")!;
const refreshBtn = document.getElementById("refresh")!;

const app = new App({ name: "HelloWorldApp", version: "1.0.0" });

app.ontoolresult = (params) => {
	if (params.isError) {
		timeEl.textContent = `Error: ${JSON.stringify(params.content)}`;
	} else if (params.content) {
		const textBlock = params.content.find(
			(b: { type: string }) => b.type === "text",
		);
		if (textBlock && "text" in textBlock) {
			timeEl.textContent = `Server time: ${textBlock.text}`;
		}
	}
};

refreshBtn.addEventListener("click", async () => {
	statusEl.textContent = "Requesting...";
	try {
		const result = await app.callServerTool({
			name: "hello_world_refresh",
			arguments: {},
		});
		if (result.isError) {
			timeEl.textContent = `Error: ${JSON.stringify(result.content)}`;
		} else {
			const textBlock = result.content?.find(
				(b: { type: string }) => b.type === "text",
			);
			if (textBlock && "text" in textBlock) {
				timeEl.textContent = `Server time: ${textBlock.text}`;
			}
		}
		statusEl.textContent = "Connected";
	} catch (err) {
		statusEl.textContent = `Error: ${err}`;
	}
});

app
	.connect()
	.then(() => {
		statusEl.textContent = "Connected";
		timeEl.textContent = "Click Refresh to get server time";
	})
	.catch((err) => {
		statusEl.textContent = `Connection failed: ${err}`;
	});
