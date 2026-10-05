import { describe, expect, it } from "vite-plus/test";

import { buildIssuePrompt, mergeIssuePrompt } from "./issueThread.logic";

const issue = {
  number: 31,
  title: "Add dark mode",
  body: "Users want it.\n\nSee screenshots.",
  url: "https://github.com/o/r/issues/31",
  state: "open" as const,
};

describe("buildIssuePrompt", () => {
  it("includes reference, title, body, and url", () => {
    expect(buildIssuePrompt(issue)).toBe(
      "Work on #31: Add dark mode\n\nUsers want it.\n\nSee screenshots.\n\nhttps://github.com/o/r/issues/31",
    );
  });

  it.each([null, "", "   \n "])("omits an empty body (%j)", (body) => {
    expect(buildIssuePrompt({ ...issue, body })).toBe(
      "Work on #31: Add dark mode\n\nhttps://github.com/o/r/issues/31",
    );
  });
});

describe("mergeIssuePrompt", () => {
  const prompt = buildIssuePrompt(issue);

  it("uses the issue prompt for an empty draft", () => {
    expect(mergeIssuePrompt("  ", prompt, issue.url)).toBe(prompt);
  });

  it("keeps typed text and appends the issue", () => {
    expect(mergeIssuePrompt("Use tailwind", prompt, issue.url)).toBe(`Use tailwind\n\n${prompt}`);
  });

  it("does not add the same issue twice", () => {
    const once = mergeIssuePrompt("", prompt, issue.url);
    expect(mergeIssuePrompt(once, prompt, issue.url)).toBe(once);
  });
});
