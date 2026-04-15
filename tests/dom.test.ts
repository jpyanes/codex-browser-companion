import { JSDOM } from "jsdom";
import { MAX_VISIBLE_TEXT_CHARS } from "../src/shared/constants";
import { capturePageSnapshot, capturePageState } from "../src/shared/dom";

function makeDocument(html: string, url = "https://example.com/"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe("page extraction", () => {
  it("captures a standard content page", () => {
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>Field Notes</title></head>
        <body>
          <main>
            <h1>Field Notes</h1>
            <p>This is a plain content page for reading.</p>
            <a href="https://example.com/docs">Docs</a>
            <button>Save draft</button>
          </main>
        </body>
      </html>
    `);

    const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

    expect(snapshot.pageKind).toBe("mixed");
    expect(snapshot.headings[0]?.text).toContain("Field Notes");
    expect(snapshot.interactiveElements.length).toBeGreaterThan(0);
    expect(snapshot.summary).toContain("interactive control");
  });

  it("captures a form page without leaking values", () => {
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>Profile Form</title></head>
        <body>
          <form aria-label="Profile form">
            <label for="name">Name</label>
            <input id="name" name="name" placeholder="Your name" />
            <label for="country">Country</label>
            <select id="country" name="country">
              <option>United States</option>
              <option>Canada</option>
            </select>
            <button type="submit">Save</button>
          </form>
        </body>
      </html>
    `);

    const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

    expect(snapshot.pageKind).toBe("form");
    expect(snapshot.forms).toHaveLength(1);
    expect(snapshot.forms[0]?.fieldCount).toBe(2);
    expect(snapshot.forms[0]?.hasPasswordField).toBe(false);
    expect(snapshot.interactiveElements.some((element) => element.label === "Name")).toBe(true);
  });

  it("captures a dynamic SPA page when navigation mode is spa", () => {
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>Dashboard</title></head>
        <body>
          <div id="app" data-router-view>
            <h1>Dashboard</h1>
            <button>Refresh data</button>
            <div aria-live="polite">Loaded</div>
          </div>
        </body>
      </html>
    `);

    const snapshot = capturePageSnapshot(document, { mode: "summary", navigationMode: "spa" }).snapshot;

    expect(snapshot.pageKind).toBe("spa");
    expect(snapshot.meta.isSinglePageApp).toBe(true);
    expect(snapshot.summary).toContain("spa page");
  });

  it("detects login pages and blocks sensitive capture paths", () => {
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>Sign in</title></head>
        <body>
          <form aria-label="Sign in">
            <label for="email">Email</label>
            <input id="email" type="email" />
            <label for="password">Password</label>
            <input id="password" type="password" />
            <button type="submit">Sign in</button>
          </form>
        </body>
      </html>
    `);

    const snapshot = capturePageSnapshot(document, { mode: "interactive", navigationMode: "document" }).snapshot;

    expect(snapshot.pageKind).toBe("login");
    expect(snapshot.meta.hasSensitiveInputs).toBe(true);
    expect(snapshot.forms[0]?.hasPasswordField).toBe(true);
    expect(snapshot.interactiveElements.some((element) => element.isSensitive)).toBe(true);
  });

  it("caps visible text for long article pages", () => {
    const longParagraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(220);
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>Long Article</title></head>
        <body>
          <article>
            <h1>Long Article</h1>
            <h2>Introduction</h2>
            <p>${longParagraph}</p>
            <h2>More Details</h2>
            <p>${longParagraph}</p>
          </article>
        </body>
      </html>
    `);

    const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

    expect(snapshot.pageKind).toBe("article");
    expect(snapshot.visibleText.length).toBeLessThanOrEqual(MAX_VISIBLE_TEXT_CHARS);
    expect(snapshot.suggestedActions.some((action) => action.id === "summarize-page")).toBe(true);
  });

  it("produces a basic page state snapshot", () => {
    const document = makeDocument(`
      <!doctype html>
      <html>
        <head><title>State Page</title></head>
        <body><main><button>Action</button></main></body>
      </html>
    `);

    const state = capturePageState(document, "document");
    expect(state.title).toBe("State Page");
    expect(state.interactiveCount).toBeGreaterThan(0);
  });
});
