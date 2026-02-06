#!/usr/bin/env node

/**
 * Update demo-wallet to the latest Aztec nightly version.
 *
 * Usage:
 *   node scripts/update-to-nightly.js [--version VERSION] [--rollup-version VERSION] [--skip-aztec-up]
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Color codes
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

function log(color, message) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function exec(command, options = {}) {
  return execSync(command, {
    cwd: options.cwd || ROOT,
    stdio: options.silent ? "pipe" : "inherit",
    encoding: "utf-8",
    ...options,
  });
}

async function fetchLatestNightly() {
  log(COLORS.yellow, "Fetching latest nightly from npm...");
  try {
    const output = exec("npm view @aztec/aztec.js versions --json", { silent: true });
    const versions = JSON.parse(output);
    const nightlies = versions.filter((v) => v.match(/^4\.0\.0-nightly\.\d+$/));
    const latest = nightlies[nightlies.length - 1];
    if (!latest) {
      throw new Error("No nightly versions found");
    }
    return latest;
  } catch (error) {
    log(COLORS.red, "Failed to fetch latest nightly version from npm");
    log(COLORS.red, "Please specify a version with --version");
    process.exit(1);
  }
}

async function fetchRollupVersion() {
  log(COLORS.yellow, "Fetching rollup version from nextnet...");
  try {
    const output = exec(
      "curl -s https://nextnet.aztec-labs.com/status | jq -r '.l2ContractAddresses.rollupAddress.version'",
      { silent: true }
    );
    const version = output.trim();
    if (!version || version === "null") {
      throw new Error("Failed to fetch rollup version");
    }
    log(COLORS.green, `Fetched rollup version: ${version}`);
    return version;
  } catch (error) {
    log(COLORS.red, "Failed to fetch rollup version from nextnet");
    return null;
  }
}

function updatePackageJson(path, version) {
  let content = readFileSync(path, "utf-8");
  content = content.replace(
    /@aztec\/([^"]+)": "v4\.0\.0-nightly\.\d+"/g,
    `@aztec/$1": "v${version}"`
  );
  writeFileSync(path, content, "utf-8");
}

function updateAppPackageJson(version) {
  log(COLORS.yellow, "[1/5] Updating app/package.json...");
  updatePackageJson(resolve(ROOT, "app/package.json"), version);
  log(COLORS.green, "✓ app/package.json updated\n");
}

function updateExtensionPackageJson(version) {
  log(COLORS.yellow, "[2/5] Updating extension/package.json...");
  updatePackageJson(resolve(ROOT, "extension/package.json"), version);
  log(COLORS.green, "✓ extension/package.json updated\n");
}

function installDependencies() {
  log(COLORS.yellow, "[3/5] Running yarn install in app/ and extension/...");
  exec("yarn install", { cwd: resolve(ROOT, "app") });
  exec("yarn install", { cwd: resolve(ROOT, "extension") });
  log(COLORS.green, "✓ Dependencies installed\n");
}

function installAztecCLI(version) {
  log(COLORS.yellow, `[4/5] Installing Aztec CLI version ${version}...`);

  const isCI = !!process.env.CI;

  if (isCI) {
    // CI environment - use direct curl install
    log(COLORS.yellow, `Running version-specific installer for ${version}...`);
    process.env.FOUNDRY_DIR = `${process.env.HOME}/.foundry`;
    exec(`curl -fsSL "https://install.aztec.network/${version}/install" | VERSION="${version}" bash`);

    // Update PATH for current session
    process.env.PATH = `${process.env.HOME}/.aztec/versions/${version}/bin:${process.env.PATH}`;
    process.env.PATH = `${process.env.HOME}/.aztec/versions/${version}/node_modules/.bin:${process.env.PATH}`;
    log(COLORS.green, "✓ Aztec CLI installed (CI mode)\n");
  } else {
    // Local environment with aztec-up
    try {
      exec("command -v aztec-up", { silent: true });
      exec(`aztec-up install ${version}`);
      log(COLORS.green, "✓ Aztec CLI updated\n");
    } catch {
      log(COLORS.red, `Warning: aztec-up not found in PATH. Please install manually with: aztec-up install ${version}\n`);
    }
  }
}

function updateRollupVersion(rollupVersion) {
  log(COLORS.yellow, `[5/5] Updating nextnet rollup version to ${rollupVersion}...`);
  const networksFile = resolve(ROOT, "app/src/config/networks.ts");
  let content = readFileSync(networksFile, "utf-8");

  // Find the nextnet config and update its version
  const lines = content.split("\n");
  let inNextnetBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('id: "nextnet"')) {
      inNextnetBlock = true;
    }
    if (inNextnetBlock && lines[i].match(/version:\s*\d+/)) {
      lines[i] = lines[i].replace(/version:\s*\d+/, `version: ${rollupVersion}`);
      break;
    }
  }

  writeFileSync(networksFile, lines.join("\n"), "utf-8");
  log(COLORS.green, "✓ Rollup version updated in networks.ts\n");
}

async function main() {
  log(COLORS.green, "=== Demo Wallet Nightly Update Script ===\n");

  // Parse arguments
  const args = process.argv.slice(2);
  let version = null;
  let rollupVersion = null;
  let skipAztecUp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[i + 1].replace(/^v/, "");
      i++;
    } else if (args[i] === "--rollup-version" && args[i + 1]) {
      rollupVersion = args[i + 1];
      i++;
    } else if (args[i] === "--skip-aztec-up") {
      skipAztecUp = true;
    } else if (args[i] === "--help") {
      console.log("Usage: node scripts/update-to-nightly.js [OPTIONS]");
      console.log("\nOptions:");
      console.log("  --version VERSION              Specify nightly version (e.g., 4.0.0-nightly.20260206)");
      console.log("  --rollup-version VERSION       Specify rollup version for nextnet");
      console.log("  --skip-aztec-up                Skip Aztec CLI installation");
      console.log("  --help                         Show this help message");
      process.exit(0);
    }
  }

  // Fetch latest if not specified
  if (!version) {
    version = await fetchLatestNightly();
    log(COLORS.green, `Latest nightly version: v${version}\n`);
  } else {
    log(COLORS.green, `Updating to version: v${version}\n`);
  }

  // Fetch rollup version if not specified
  if (!rollupVersion) {
    rollupVersion = await fetchRollupVersion();
  }

  // Run update steps
  updateAppPackageJson(version);
  updateExtensionPackageJson(version);
  installDependencies();

  if (!skipAztecUp) {
    installAztecCLI(version);
  } else {
    log(COLORS.yellow, "[4/5] Skipping Aztec CLI installation (--skip-aztec-up flag set)\n");
  }

  if (rollupVersion) {
    updateRollupVersion(rollupVersion);
  } else {
    log(COLORS.yellow, "[5/5] No rollup version specified (use --rollup-version to update)");
    log(COLORS.yellow, "To get the rollup version from nextnet, run:");
    log(COLORS.yellow, "  curl -s https://nextnet.aztec-labs.com/status | jq -r '.l2ContractAddresses.rollupAddress.version'\n");
  }

  log(COLORS.green, "=== Update Complete ===");
  log(COLORS.green, `Version: v${version}`);
  if (rollupVersion) {
    log(COLORS.green, `Nextnet rollup version: ${rollupVersion}`);
  }
}

main().catch((error) => {
  log(COLORS.red, `Error: ${error.message}`);
  process.exit(1);
});
