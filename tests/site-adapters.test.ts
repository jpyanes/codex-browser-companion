import { JSDOM } from "jsdom";
import { capturePageSnapshot } from "../src/shared/dom";

function makeDocument(html: string, url: string): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe("site adapters", () => {
  it("detects Google sign-in pages and keeps the login boundary explicit", () => {
    const document = makeDocument(
      `
        <!doctype html>
        <html>
          <head><title>Sign in - Google Accounts</title></head>
          <body>
            <form aria-label="Google sign in">
              <label for="email">Email</label>
              <input id="email" type="email" />
              <label for="password">Password</label>
              <input id="password" type="password" />
              <button type="submit">Next</button>
            </form>
          </body>
        </html>
      `,
      "https://accounts.google.com/",
    );

    const snapshot = capturePageSnapshot(document, { mode: "summary", navigationMode: "document" }).snapshot;

    expect(snapshot.siteAdapter?.id).toBe("google-login");
    expect(snapshot.summary).toContain("Google sign-in is active");
    expect(snapshot.suggestedActions.some((action) => action.source === "site")).toBe(false);
  });

  it("suggests focusing the Google Docs editor surface", () => {
    const document = makeDocument(
      `
        <!doctype html>
        <html>
          <head><title>Untitled document - Google Docs</title></head>
          <body>
            <div contenteditable="true" role="textbox" aria-label="Document body">hello</div>
            <button aria-label="Bold">Bold</button>
          </body>
        </html>
      `,
      "https://docs.google.com/document/d/abc/edit",
    );

    const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

    expect(snapshot.siteAdapter?.id).toBe("google-docs");
    expect(snapshot.summary).toContain("Google Docs is ready");
    expect(snapshot.suggestedActions.some((action) => action.source === "site" && action.title.includes("Focus document body"))).toBe(true);
  });

  it("suggests liking the first visible LinkedIn post when a Like control is present", () => {
    const document = makeDocument(
      `
        <!doctype html>
        <html>
          <head><title>LinkedIn Feed</title></head>
          <body>
            <main>
              <article>
                <p>First visible post</p>
                <button aria-label="Like">Like</button>
                <button aria-label="Comment">Comment</button>
              </article>
            </main>
          </body>
        </html>
      `,
      "https://www.linkedin.com/feed/",
    );

    const snapshot = capturePageSnapshot(document, { mode: "full", navigationMode: "document" }).snapshot;

    expect(snapshot.siteAdapter?.id).toBe("linkedin-feed");
    expect(snapshot.summary).toContain("LinkedIn feed or profile content is visible");
    expect(snapshot.suggestedActions.some((action) => action.source === "site" && action.title.includes("Like the first visible post"))).toBe(true);
  });
});
