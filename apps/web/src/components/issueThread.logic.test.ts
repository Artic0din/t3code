import { describe, expect, it } from "vite-plus/test";

import { applyIssuePrefill, buildIssuePrompt, mergeIssuePrompt } from "./issueThread.logic";

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

  it("adds issue 3 even when the draft already holds issue 31", () => {
    const issue3 = {
      ...issue,
      number: 3,
      title: "Typo",
      body: null,
      url: "https://github.com/o/r/issues/3",
    };
    const draft = `Notes about https://github.com/o/r/issues/31 first`;
    expect(mergeIssuePrompt(draft, buildIssuePrompt(issue3), issue3.url)).toBe(
      `${draft}\n\n${buildIssuePrompt(issue3)}`,
    );
  });

  it("replaces an untouched previous issue prompt instead of mixing two issues", () => {
    const issue3 = {
      ...issue,
      number: 3,
      title: "Typo",
      body: null,
      url: "https://github.com/o/r/issues/3",
    };
    expect(mergeIssuePrompt(prompt, buildIssuePrompt(issue3), issue3.url, prompt)).toBe(
      buildIssuePrompt(issue3),
    );
  });

  it("keeps an edited previous issue prompt", () => {
    const issue3 = {
      ...issue,
      number: 3,
      title: "Typo",
      body: null,
      url: "https://github.com/o/r/issues/3",
    };
    const edited = `${prompt}\n\nAlso fix the footer.`;
    expect(mergeIssuePrompt(edited, buildIssuePrompt(issue3), issue3.url, prompt)).toBe(
      `${edited}\n\n${buildIssuePrompt(issue3)}`,
    );
  });

  it("recognizes the issue url followed by punctuation", () => {
    const draft = `Context in ${issue.url}.`;
    expect(mergeIssuePrompt(draft, prompt, issue.url)).toBe(draft);
  });

  it("does not add the same issue twice", () => {
    const once = mergeIssuePrompt("", prompt, issue.url);
    expect(mergeIssuePrompt(once, prompt, issue.url)).toBe(once);
  });
});

describe("applyIssuePrefill", () => {
  const issueA = {
    ...issue,
    number: 1,
    title: "A",
    body: null,
    url: "https://github.com/o/r/issues/1",
  };
  const issueB = {
    ...issue,
    number: 2,
    title: "B",
    body: null,
    url: "https://github.com/o/r/issues/2",
  };
  const issueC = {
    ...issue,
    number: 3,
    title: "C",
    body: null,
    url: "https://github.com/o/r/issues/3",
  };

  it("never deletes user text across repeated issue starts", () => {
    const first = applyIssuePrefill("", undefined, issueA);
    const edited = `${first.prompt}\n\nKeep the API stable.`;
    const second = applyIssuePrefill(edited, first.prefill, issueB);
    const third = applyIssuePrefill(second.prompt, second.prefill, issueC);

    expect(third.prompt).toContain("Keep the API stable.");
    expect(third.prompt).toContain(issueC.url);
  });

  it("replaces an untouched issue prefill", () => {
    const first = applyIssuePrefill("", undefined, issueA);
    const second = applyIssuePrefill(first.prompt, first.prefill, issueB);

    expect(second.prompt).toBe(buildIssuePrompt(issueB));
    expect(second.prefill).toBe(second.prompt);
  });
});
