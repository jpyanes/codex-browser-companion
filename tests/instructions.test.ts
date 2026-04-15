import { JSDOM } from "jsdom";
import { capturePageSnapshot } from "../src/shared/dom";
import { parseInstruction } from "../src/shared/instructions";

function makeDocument(html: string, url = "https://example.com/"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe("instruction parsing", () => {
  const document = makeDocument(`
    <!doctype html>
    <html>
      <head><title>Command Page</title></head>
      <body>
        <main>
          <button>Save changes</button>
          <label for="search">Search</label>
          <input id="search" type="text" placeholder="Search site" />
          <select id="country" name="country">
            <option>United States</option>
            <option>Canada</option>
          </select>
        </main>
      </body>
    </html>
  `);

  const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

  it("parses click instructions into actions", () => {
    const parsed = parseInstruction("click save", snapshot);
    expect(parsed?.request.kind).toBe("request-action");
    if (parsed?.request.kind === "request-action") {
      expect(parsed.request.action.kind).toBe("click");
      if (parsed.request.action.kind === "click") {
        expect(parsed.request.action.label?.toLowerCase()).toContain("save");
      }
    }
  });

  it("parses type instructions into actions", () => {
    const parsed = parseInstruction("type hello into search", snapshot);
    expect(parsed?.request.kind).toBe("request-action");
    if (parsed?.request.kind === "request-action") {
      expect(parsed.request.action.kind).toBe("type");
      if (parsed.request.action.kind === "type") {
        expect(parsed.request.action.text).toBe("hello");
      }
    }
  });

  it("parses select instructions into actions", () => {
    const parsed = parseInstruction("select Canada in country", snapshot);
    expect(parsed?.request.kind).toBe("request-action");
    if (parsed?.request.kind === "request-action") {
      expect(parsed.request.action.kind).toBe("select");
      if (parsed.request.action.kind === "select") {
        expect(parsed.request.action.selection.by).toBe("label");
        expect(parsed.request.action.selection.value).toBe("Canada");
      }
    }
  });

  it("parses simple scroll and navigation commands", () => {
    const scroll = parseInstruction("scroll down 300", snapshot);
    expect(scroll?.request.kind).toBe("request-action");
    if (scroll?.request.kind === "request-action") {
      expect(scroll.request.action.kind).toBe("scroll");
      if (scroll.request.action.kind === "scroll") {
        expect(scroll.request.action.amount).toBe(300);
      }
    }

    expect(parseInstruction("go back", snapshot)?.request.kind).toBe("request-action");
    expect(parseInstruction("refresh", snapshot)?.request.kind).toBe("request-action");
  });

  it("parses page summary commands without needing a snapshot", () => {
    const parsed = parseInstruction("summarize page", null);
    expect(parsed?.request.kind).toBe("scan-page");
    if (parsed?.request.kind === "scan-page") {
      expect(parsed.request.mode).toBe("summary");
    }
  });
});
