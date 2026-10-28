import { describe, expect, it } from "vitest";
import { encode, lineSplitter } from "../src/protocol.ts";
import type { ClientMessage } from "../src/protocol.ts";

describe("protocol", () => {
  it("encode ends with newline", () => {
    expect(encode({ type: "msg", text: "hi" })).toBe('{"type":"msg","text":"hi"}\n');
  });

  it("splitter handles a line split across two chunks", () => {
    const got: unknown[] = [];
    const feed = lineSplitter((o) => got.push(o));
    feed('{"type":"do');
    feed('ne"}\n');
    expect(got).toEqual([{ type: "done" }]);
  });

  it("splitter handles two lines in one chunk", () => {
    const got: unknown[] = [];
    const feed = lineSplitter((o) => got.push(o));
    feed(Buffer.from('{"a":1}\n{"a":2}\n'));
    expect(got).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("splitter ignores blank lines", () => {
    const got: unknown[] = [];
    const feed = lineSplitter((o) => got.push(o));
    feed("\n  \n{\"a\":1}\n\n");
    expect(got).toEqual([{ a: 1 }]);
  });

  it("bad JSON surfaces as error event", () => {
    const got: unknown[] = [];
    const feed = lineSplitter((o) => got.push(o));
    feed("nope\n");
    expect(got).toEqual([{ type: "error", message: "bad line: nope" }]);
  });
  it("a client can send an inject message", () => {
    const m: ClientMessage = { type: "inject", text: "also check b" };
    const got: unknown[] = [];
    lineSplitter((o) => got.push(o))(encode(m));
    expect(got).toEqual([{ type: "inject", text: "also check b" }]);
  });
});
