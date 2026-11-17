// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";

const ASSET = "multica-cli-9.9.9-test.tar.gz";

const state = vi.hoisted(() => ({ userData: "", renames: [] as Array<[string, string]> }));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => state.userData) },
}));

vi.mock("./cli-release-asset", () => ({
  selectPlatformReleaseAssetName: () => "multica-cli-9.9.9-test.tar.gz",
}));

// Model the real constraint: rename() fails with EXDEV when source and
// destination sit on different filesystems. Here the userData root stands in
// for the home filesystem and everything outside it for a separate /tmp.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      state.renames.push([from, to]);
      const onDevice = (p: string) => !relative(state.userData, p).startsWith("..");
      if (onDevice(from) !== onDevice(to)) {
        throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`), {
          code: "EXDEV",
        });
      }
      return actual.rename(from, to);
    }),
  };
});

import { ensureManagedCli, managedCliPath } from "./cli-bootstrap";

let scratch: string;
let archive: Buffer;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cli-bootstrap-test-"));
  state.userData = join(scratch, "userData");
  state.renames = [];

  const src = join(scratch, "src");
  mkdirSync(src);
  writeFileSync(join(src, "multica"), "#!/bin/sh\necho fake multica\n");
  execFileSync("tar", ["-czf", join(scratch, ASSET), "-C", src, "multica"]);
  archive = readFileSync(join(scratch, ASSET));
  const sum = createHash("sha256").update(archive).digest("hex");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/checksums.txt")
        ? new Response(`${sum}  ${ASSET}\n`)
        : new Response(new Uint8Array(archive)),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("ensureManagedCli", () => {
  it("installs when the system temp dir is on another filesystem than userData", async () => {
    const installed = await ensureManagedCli({ forceInstall: true });

    expect(installed).toBe(managedCliPath());
    expect(readFileSync(installed, "utf8")).toContain("fake multica");
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    // The binary was staged beside its target, so the swap never crossed filesystems.
    expect(state.renames).toHaveLength(1);
    expect(dirname(dirname(state.renames[0][0]))).toBe(dirname(installed));
  });

  it("replaces an existing CLI and leaves no staging dir behind", async () => {
    mkdirSync(dirname(managedCliPath()), { recursive: true });
    writeFileSync(managedCliPath(), "old");

    await ensureManagedCli({ forceInstall: true });

    expect(readFileSync(managedCliPath(), "utf8")).toContain("fake multica");
    expect(readdirSync(dirname(managedCliPath()))).toEqual(["multica"]);
  });

  it("removes the staging dir when the download fails its checksum", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/checksums.txt")
          ? new Response(`${"0".repeat(64)}  ${ASSET}\n`)
          : new Response(new Uint8Array(archive)),
      ),
    );

    await expect(ensureManagedCli({ forceInstall: true })).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(managedCliPath())).toBe(false);
    expect(readdirSync(dirname(managedCliPath()))).toEqual([]);
  });
});
