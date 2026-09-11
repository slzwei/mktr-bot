import http from "node:http";
import { EslClient } from "../esl.js";
import { FreeSwitchEslAdapter } from "../telephony.js";
import { CallOrchestrator } from "../orchestrator.js";
import { InMemoryStore } from "../store.js";
import { installShutdown } from "../shutdown.js";
import { logger } from "../logger.js";
import { fixtureEslPassword } from "./fake-esl.js";

if (process.env.MKTR_TELEPHONY_MODE !== "simulated") throw new Error("Fixture requires simulator environment.");
const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: Number(process.argv[2]), password: fixtureEslPassword }), true);
const calls = new CallOrchestrator(new InMemoryStore(), adapter);
await calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "flow-prospect-intake" });
await calls.start({ destination: "+6591234568", callerId: "+6562773212", flowId: "flow-prospect-intake" });
const server = http.createServer((_request, response) => response.end("fixture"));
server.listen(0, "127.0.0.1", () => {
  installShutdown({ server, calls, closeSseStreams() {}, logger, deadlineMs: 3000 });
  process.stdout.write("READY\n");
});
