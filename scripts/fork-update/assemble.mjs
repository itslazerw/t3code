// Builds the fork's T3 app: a copy of the official signed app with our server bundle
// (server code plus the web screens) swapped into app.asar, then signed again.
// Usage: node assemble.mjs <official.app> <apps/server/dist> <out.app> <asar-module-dir>
// Plain script, no AI. Prints one line per step; exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const [officialApp, serverDist, outApp, asarDir] = process.argv.slice(2);
if (!officialApp || !serverDist || !outApp || !asarDir) {
  console.error("usage: node assemble.mjs <official.app> <server dist> <out.app> <asar module dir>");
  process.exit(2);
}
const asar = createRequire(import.meta.url)(asarDir);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const step = (text) => console.log(`assemble: ${text}`);

// Entitlements a copy may keep. The rest belong to Ping's Apple team and would stop the app launching.
const KEEP_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.device.audio-input",
  "com.apple.security.device.camera",
];
const SIGN_IDENTITY = process.env.T3_FORK_SIGN_IDENTITY || "-"; // "-" signs without a certificate

fs.mkdirSync(path.dirname(path.resolve(outApp)), { recursive: true });
const work = fs.mkdtempSync(path.join(path.dirname(path.resolve(outApp)), ".assemble-"));
try {
  fs.rmSync(outApp, { recursive: true, force: true });
  run("ditto", [officialApp, outApp]);
  step("copied the official app");

  const resources = path.join(outApp, "Contents/Resources");
  const asarPath = path.join(resources, "app.asar");
  const unpacked = new Set(
    asar
      .listPackage(asarPath, { isPack: false })
      .filter((file) => {
        try {
          return asar.statFile(asarPath, file.slice(1)).unpacked === true;
        } catch {
          return false;
        }
      })
      .map((file) => file.slice(1)),
  );
  const tree = path.join(work, "app");
  asar.extractAll(asarPath, tree);
  step(`opened app.asar (${unpacked.size} files kept outside it)`);

  const target = path.join(tree, "apps/server/dist");
  if (!fs.existsSync(path.join(target, "bin.mjs"))) throw new Error("official app has no apps/server/dist/bin.mjs");
  fs.rmSync(target, { recursive: true });
  fs.cpSync(serverDist, target, {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  if (!fs.existsSync(path.join(target, "bin.mjs"))) throw new Error("new server bundle has no bin.mjs");
  step("swapped in our server bundle");

  const newAsar = path.join(work, "app.asar");
  await asar.createPackageWithOptions(tree, newAsar, {
    unpack: unpacked.size === 0 ? undefined : `{${[...unpacked].join(",")}}`,
  });
  fs.rmSync(asarPath);
  fs.rmSync(`${asarPath}.unpacked`, { recursive: true, force: true });
  fs.renameSync(newAsar, asarPath);
  if (fs.existsSync(`${newAsar}.unpacked`)) fs.renameSync(`${newAsar}.unpacked`, `${asarPath}.unpacked`);
  const stillUnpacked = new Set(
    asar.listPackage(asarPath).filter((file) => {
      try {
        return asar.statFile(asarPath, file.slice(1)).unpacked === true;
      } catch {
        return false;
      }
    }).map((file) => file.slice(1)),
  );
  const missing = [...unpacked].filter((file) => !stillUnpacked.has(file));
  if (missing.length > 0) throw new Error(`files no longer kept outside app.asar: ${missing.slice(0, 5).join(", ")}`);
  step("packed app.asar again");

  // Electron refuses an app.asar whose header hash does not match Info.plist.
  const header = asar.getRawHeader(asarPath).headerString;
  const hash = createHash("sha256").update(header).digest("hex");
  const plist = path.join(outApp, "Contents/Info.plist");
  run("/usr/libexec/PlistBuddy", ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, plist]);
  // The official updater would replace this build with the plain release, so it stays off here;
  // t3-fork-update brings every release in instead.
  try {
    run("/usr/libexec/PlistBuddy", ["-c", "Delete :LSEnvironment", plist]);
  } catch {}
  run("/usr/libexec/PlistBuddy", ["-c", "Add :LSEnvironment dict", plist]);
  run("/usr/libexec/PlistBuddy", ["-c", "Add :LSEnvironment:T3CODE_DISABLE_AUTO_UPDATE string true", plist]);
  step("updated Info.plist (app.asar check, updater off)");

  fs.rmSync(path.join(outApp, "Contents/embedded.provisionprofile"), { force: true });
  const entitlements = path.join(work, "entitlements.plist");
  fs.writeFileSync(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${KEEP_ENTITLEMENTS.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>\n`,
  );
  // Inside out: native modules, frameworks, helpers, then the app itself.
  const signOne = (target, withEntitlements) =>
    run("codesign", [
      "--force",
      "--sign",
      SIGN_IDENTITY,
      "--options",
      "runtime",
      ...(withEntitlements ? ["--entitlements", entitlements] : []),
      target,
    ]);
  const machO = run("find", [outApp, "-type", "f", "(", "-name", "*.node", "-o", "-name", "*.dylib", "-o", "-perm", "-u+x", ")"])
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.includes(".app/Contents/MacOS/") || file.includes("/Frameworks/"))
    .filter((file) => {
      try {
        return run("file", ["-b", file]).includes("Mach-O");
      } catch {
        return false;
      }
    });
  for (const file of machO) signOne(file, false);
  const frameworks = path.join(outApp, "Contents/Frameworks");
  for (const entry of fs.readdirSync(frameworks)) {
    if (entry.endsWith(".framework")) signOne(path.join(frameworks, entry), false);
  }
  for (const entry of fs.readdirSync(frameworks)) {
    if (entry.endsWith(".app")) signOne(path.join(frameworks, entry), true);
  }
  signOne(outApp, true);
  run("codesign", ["--verify", "--deep", "--strict", outApp]);
  step(`signed (${SIGN_IDENTITY === "-" ? "no certificate" : SIGN_IDENTITY}) and verified`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
