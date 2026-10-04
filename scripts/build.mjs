import { mkdirSync, cpSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const out = "dist";
if (!existsSync(out)) mkdirSync(out, { recursive: true });
cpSync("src", `${out}/src`, { recursive: true });
execSync(`powershell Compress-Archive -Force -Path ${out}/src/* -DestinationPath ${out}/x-stats.zip`);
console.log("built dist/x-stats.zip");
