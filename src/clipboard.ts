/**
 * Clipboard access, abstracted behind a small port so the relay can be driven
 * by the real macOS clipboard in production and by an in-memory fake in tests.
 */

import { spawn } from "node:child_process";

export interface ClipboardPort {
  read(): Promise<string>;
  write(value: string): Promise<void>;
}

function run(
  cmd: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/**
 * macOS clipboard via pbcopy/pbpaste. No native module needed, which keeps the
 * server dependency-light and avoids build steps on the user's machine.
 */
export class MacClipboard implements ClipboardPort {
  async read(): Promise<string> {
    return run("pbpaste", []);
  }

  async write(value: string): Promise<void> {
    await run("pbcopy", [], value);
  }
}

/** In-memory clipboard for tests and the loopback self-test. */
export class MemoryClipboard implements ClipboardPort {
  private value = "";

  async read(): Promise<string> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }
}
