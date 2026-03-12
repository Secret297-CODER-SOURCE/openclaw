import fs from "fs";
import { validateConfigObjectWithPlugins } from "./src/config/validation.ts";
const raw = JSON.parse(fs.readFileSync("/Users/worker/.openclaw/openclaw.json", "utf-8"));
const result = validateConfigObjectWithPlugins(raw);
if (!result.ok) {
  console.log("INVALID:", JSON.stringify(result.issues, null, 2));
} else {
  console.log("VALID, channels:", Object.keys(result.config.channels ?? {}));
}
