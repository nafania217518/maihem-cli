import net from "node:net";
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.ts";
import { encode, lineSplitter } from "./protocol.ts";
import type { AgentEvent } from "./protocol.ts";

export function attach(
  sockPath: string,
  io: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    sock.once("error", reject);
    sock.once("connect", () => {
      const app = render(
        React.createElement(App, {
          subscribe: (cb: (e: AgentEvent) => void) => {
            const feed = lineSplitter((o) => cb(o as AgentEvent));
            sock.on("data", feed);
            return () => sock.off("data", feed);
          },
          send: (text) => sock.write(encode({ type: "msg", text })),
          detach: () => sock.end(),
          stop: (apply) => sock.write(encode({ type: "stop", apply })),
          interrupt: () => sock.write(encode({ type: "interrupt" })),
        }),
        { ...io, alternateScreen: true, exitOnCtrlC: false, patchConsole: false },
      );
      sock.once("close", () => {
        app.unmount();
        resolve();
      });
    });
  });
}
