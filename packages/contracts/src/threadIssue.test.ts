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
    expect(threadIssueKeysEqual(issue(), issue({ host: "www.GitHub.com" }))).toBe(false);
  });

  it("preserves an Enterprise hostname with a www prefix", () => {
    expect(parseGitHubIssueUrl("https://www.github.example.com/acme/web/issues/12")).toEqual({
      host: "www.github.example.com",
      repository: "acme/web",
      number: 12,
      url: "https://www.github.example.com/acme/web/issues/12",
    });
  });

  it("keeps Enterprise aliases separate for related work and stale unlinks", () => {
    const first = issue({ host: "www.github.example.com" });
    const replacement = issue({ host: "github.example.com" });
    expect(threadIssueKeysEqual(first, replacement)).toBe(false);
    expect(
      relatedIssueThreads(
        [
          { id: ThreadId.make("first-host"), linkedIssue: first },
          { id: ThreadId.make("second-host"), linkedIssue: replacement },
        ],
        first,
      ).map((thread) => thread.id),
    ).toEqual([ThreadId.make("first-host")]);
    expect(nextLinkedIssue(replacement, { type: "thread.issue.unlink", ...first })).toBeUndefined();
    expect(
      nextLinkedIssue(replacement, { type: "thread.issue.unlink", ...replacement }),
    ).toBeNull();
  });

  it("parses GitHub issue URLs and ignores pull requests", () => {
    expect(parseGitHubIssueUrl("https://github.com/Artic0din/t3code/issues/14#note")).toMatchObject(
      {
        host: "github.com",
        repository: "artic0din/t3code",
        number: 14,
        url: "https://github.com/artic0din/t3code/issues/14",
      },
    );
    expect(parseGitHubIssueUrl("https://github.example.com/Acme/Web/issues/12")).toMatchObject({
      host: "github.example.com",
      repository: "acme/web",
      number: 12,
      url: "https://github.example.com/acme/web/issues/12",
    });
    expect(parseGitHubIssueUrl("https://github.com/Artic0din/t3code/pull/14")).toBeNull();
  });

  it("parses an issue in a repository named issues", () => {
    expect(parseGitHubIssueUrl("https://github.com/acme/issues/issues/14")).toEqual({
      host: "github.com",
      repository: "acme/issues",
      number: 14,
      url: "https://github.com/acme/issues/issues/14",
    });
    expect(parseGitHubIssueUrl("https://github.com/acme/issues/pull/14")).toBeNull();
  });

  it.each(["https://github.com", "https://github.example.com"])(
    "persists resolved issues when the owner and repository are named issues on %s",
    (origin) => {
      const resolved = {
        number: 14,
        title: "Persist issue links",
        body: null,
        url: `${origin}/issues/issues/issues/14#note`,
        state: "open" as const,
      };
      expect(linkedIssueFromResolved(resolved)).toEqual({
        host: new URL(origin).hostname,
        repository: "issues/issues",
        number: 14,
        url: `${origin}/issues/issues/issues/14`,
        title: "Persist issue links",
        availability: "open",
      });
    },
  );

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
    expect(
      nextLinkedIssue(current, { type: "thread.issue.unlink", expectedIssue: null }),
    ).toBeUndefined();
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
