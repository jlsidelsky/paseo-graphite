// The daemon's config RPC drops `cors`, so edit the file; the daemon reads it at startup.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const ORIGIN = "chrome-extension://lflfieeldgejaiigfkkmofeekdlgloam";
const path = `${homedir()}/.paseo/config.json`;
const config = JSON.parse(readFileSync(path, "utf8"));
config.daemon ??= {};
config.daemon.cors ??= {};
const origins = (config.daemon.cors.allowedOrigins ??= []);
if (!origins.includes(ORIGIN)) {
  origins.push(ORIGIN);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
console.log(config.daemon.cors);
