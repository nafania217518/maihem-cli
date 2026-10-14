// A Backend is where an agent's tools act: the host workdir, or a sandbox workspace.
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Backend {
  /** Root the agent works in: an absolute host path, or "/workspace" in the sandbox. */
  root: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, cwd?: string): Promise<ExecResult>;
}
