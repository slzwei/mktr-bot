import path from "node:path";
import { fileURLToPath } from "node:url";
import { CALLER_IDS } from "../src/lib/domain.js";
import { callbackCallerId } from "../server/inbound-config.js";

/** Constructs an internal endpoint diagnostic only; never executes fs_cli. */
export function inboundLoopbackCommand(destination: string = CALLER_IDS[0]): string {
  if (!callbackCallerId(destination)) throw new Error("Loopback destination must be in the approved caller-ID pool.");
  return `originate {loopback_bowout=false,origination_caller_id_name=MKTR_CALLBACK_TEST,origination_caller_id_number=${CALLER_IDS[0]},originate_timeout=10,execute_on_answer='sched_hangup +20 ALLOTTED_TIMEOUT'}loopback/${destination}/public &park()`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(" ") !== "--dry-run") {
    process.stderr.write("Only --dry-run is supported. Shawn runs the isolated FreeSWITCH diagnostic manually.\n");
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify(["fs_cli", "-Q", "-x", inboundLoopbackCommand()]) + "\n");
}
