import { describe, expect, it } from "vite-plus/test";

import {
  draftIssueAfterStart,
  durableIssueForSend,
  issueAvailabilityFromFailure,
  issueLinkApplies,
  linkedIssueFromResolved,
  nextLinkedIssue,
  parseGitHubIssueUrl,
  relatedIssueThreads,
  threadIssueKeysEqual,
  type ThreadLinkedIssue,
} from "./threadIssue.ts";
import { ThreadId } from "./baseSchemas.ts";

const issue = (patch: Partial<ThreadLinkedIssue> = {}): ThreadLinkedIssue => ({
  host: "github.com",
  repository: "artic0din/t3code",
  number: 14,
  url: "https://github.com/artic0din/t3code/issues/14",
  title: "Persist issue links",
  availability: "open",
  ...patch,
});

describe("thread issue identity", () => {
  it("treats host and repository as part of the identity", () => {
    expect(
      threadIssueKeysEqual(issue(), issue({ host: "GitHub.com", repository: "Artic0din/T3Code" })),
    ).toBe(true);
    expect(threadIssueKeysEqual(issue(), issue({ repository: "pingdotgg/t3code" }))).toBe(false);
    expect(threadIssueKeysEqual(issue(), issue({ host: "github.example.com" }))).toBe(false);
    expect(threadIssueKeysEqual(issue(), issue({ number: 15 }))).toBe(false);
  });

  it("parses GitHub issue URLs and ignores pull requests", () => {
    expect(
      parseGitHubIssueUrl("https://www.github.com/Artic0din/t3code/issues/14#note"),
    ).toMatchObject({
      host: "github.com",
      repository: "artic0din/t3code",
      number: 14,
      url: "https://www.github.com/artic0din/t3code/issues/14",
    });
    expect(parseGitHubIssueUrl("https://github.com/Artic0din/t3code/pull/14")).toBeNull();
  });

  it("keeps one association when the same issue is linked again", () => {
    const current = issue();
    expect(nextLinkedIssue(current, { type: "thread.issue.link", ...current })).toBeUndefined();
    expect(
      nextLinkedIssue(current, {
        type: "thread.issue.link",
        ...issue({ repository: "other/repo", url: "https://github.com/other/repo/issues/14" }),
      }),
    ).toMatchObject({ repository: "other/repo" });
  });

  it("does not let a stale unlink clear a newer issue", () => {
    const current = issue({ repository: "other/repo" });
    expect(
      nextLinkedIssue(current, {
        type: "thread.issue.unlink",
        host: "github.com",
        repository: "artic0din/t3code",
        number: 14,
      }),
    ).toBeUndefined();
    expect(
      nextLinkedIssue(current, {
        type: "thread.issue.unlink",
        host: "github.com",
        repository: "other/repo",
        number: 14,
      }),
    ).toBeNull();
  });

  it("finds related threads only for the same host and repository", () => {
    const threads = [
      { id: ThreadId.make("a"), linkedIssue: issue() },
      { id: ThreadId.make("b"), linkedIssue: issue() },
      { id: ThreadId.make("c"), linkedIssue: issue({ repository: "other/repo" }) },
      { id: ThreadId.make("d"), linkedIssue: null },
    ];
    expect(
      relatedIssueThreads(threads, issue(), ThreadId.make("a")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("b")]);
  });
});

describe("draft durability", () => {
  it("does not attach a cancelled draft or a send from another thread", () => {
    const linked = issue();
    expect(
      durableIssueForSend({ linkedIssue: linked, cancelled: true, belongsToDraft: true }),
    ).toBeNull();
    expect(
      durableIssueForSend({ linkedIssue: linked, cancelled: false, belongsToDraft: false }),
    ).toBeNull();
    expect(
      durableIssueForSend({ linkedIssue: linked, cancelled: false, belongsToDraft: true }),
    ).toBe(linked);
  });

  it("keeps the previous draft issue when the new URL is not a GitHub issue", () => {
    const current = issue();
    expect(
      draftIssueAfterStart(current, {
        number: 3,
        title: "Typo",
        body: null,
        url: "https://example.com/not-an-issue",
        state: "open",
      }),
    ).toBe(current);
  });

  it("replaces the draft issue when a later start resolves", () => {
    const next = linkedIssueFromResolved({
      number: 3,
      title: "Typo",
      body: null,
      url: "https://github.com/artic0din/t3code/issues/3",
      state: "closed",
    });
    expect(
      draftIssueAfterStart(issue(), {
        number: 3,
        title: "Typo",
        body: null,
        url: "https://github.com/artic0din/t3code/issues/3",
        state: "closed",
      }),
    ).toEqual(next);
  });
});

describe("issue link responses", () => {
  it("drops a response after the active environment changes", () => {
    expect(
      issueLinkApplies({ requestedEnvironmentId: "env-a", activeEnvironmentId: "env-a" }),
    ).toBe(true);
    expect(
      issueLinkApplies({ requestedEnvironmentId: "env-a", activeEnvironmentId: "env-b" }),
    ).toBe(false);
  });

  it("classifies missing and inaccessible lookups", () => {
    expect(issueAvailabilityFromFailure("could not find issue")).toBe("missing");
    expect(issueAvailabilityFromFailure("authentication required")).toBe("inaccessible");
    expect(issueAvailabilityFromFailure("network down")).toBeNull();
  });
});
