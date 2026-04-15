#!/usr/bin/env node
/**
 * Patch @github/copilot-sdk to fix ESM import of vscode-jsonrpc.
 * The SDK's session.js imports "vscode-jsonrpc/node" without the .js extension,
 * which breaks ESM module resolution. This patch adds the .js extension.
 *
 * See: https://github.com/github/copilot-sdk/issues (not yet filed)
 * Can be removed once the SDK ships the fix.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkDist = path.join(__dirname, "..", "node_modules", "@github", "copilot-sdk", "dist");

const files = ["session.js", "session.d.ts"];
let patched = 0;

for (const file of files) {
    const filePath = path.join(sdkDist, file);
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, "utf-8");
    if (content.includes('"vscode-jsonrpc/node"') && !content.includes('"vscode-jsonrpc/node.js"')) {
        content = content.replace(/from "vscode-jsonrpc\/node"/g, 'from "vscode-jsonrpc/node.js"');
        fs.writeFileSync(filePath, content, "utf-8");
        patched++;
    }
}

if (patched > 0) {
    console.log(`[postinstall] Patched ${patched} file(s) in @github/copilot-sdk for ESM compatibility`);
}

/**
 * Patch duroxide to use duroxide-windows-x64 instead of duroxide-win32-x64-msvc.
 * The duroxide package's loader (index.js) is hardcoded to require the platform-specific
 * native module by old names. This patch updates the references to use the new package names.
 *
 * Can be removed once the duroxide package is updated upstream.
 */
const duroxideIndexPath = path.join(__dirname, "..", "node_modules", "duroxide", "index.js");
const duroxidePkgPath = path.join(__dirname, "..", "node_modules", "duroxide", "package.json");

let duroxydePatched = 0;

// Patch index.js to use new package names
if (fs.existsSync(duroxideIndexPath)) {
    let content = fs.readFileSync(duroxideIndexPath, "utf-8");
    if (content.includes("require('duroxide-win32-x64-msvc')")) {
        content = content.replace(/require\('duroxide-win32-x64-msvc'\)/g, "require('duroxide-windows-x64')");
        fs.writeFileSync(duroxideIndexPath, content, "utf-8");
        duroxydePatched++;
    }
}

// Patch package.json optionalDependencies
if (fs.existsSync(duroxidePkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(duroxidePkgPath, "utf-8"));
    if (pkg.optionalDependencies && pkg.optionalDependencies["duroxide-win32-x64-msvc"]) {
        pkg.optionalDependencies["duroxide-windows-x64"] = pkg.optionalDependencies["duroxide-win32-x64-msvc"];
        delete pkg.optionalDependencies["duroxide-win32-x64-msvc"];
        fs.writeFileSync(duroxidePkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
        duroxydePatched++;
    }
}

if (duroxydePatched > 0) {
    console.log(`[postinstall] Patched ${duroxydePatched} file(s) in duroxide for Windows x64 native binding`);
}
