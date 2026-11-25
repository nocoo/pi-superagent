import { describe, expect, it } from "vitest";
import {
  focusSearchInput,
  focusSearchInputWhenReady,
  isSearchShortcut,
  searchInputSelector,
} from "../web/src/search-focus.ts";

interface SearchDocumentState {
  mounted: boolean;
  focused: number;
}

function fakeDocument(state: SearchDocumentState) {
  return {
    querySelector: (selector: string) => {
      if (selector !== searchInputSelector || !state.mounted) return null;
      return {
        focus: () => {
          state.focused += 1;
        },
      };
    },
  };
}

describe("search shortcut focus", () => {
  it("matches the platform search shortcut only with a modifier", () => {
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, key: "k" })).toBe(true);
    expect(isSearchShortcut({ metaKey: false, ctrlKey: true, key: "K" })).toBe(true);
    expect(isSearchShortcut({ metaKey: false, ctrlKey: false, key: "k" })).toBe(false);
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, key: "j" })).toBe(false);
  });

  it("focuses an already mounted search input without scheduling a retry", () => {
    const state: SearchDocumentState = { mounted: true, focused: 0 };
    const scheduled: (() => void)[] = [];
    focusSearchInputWhenReady(fakeDocument(state), (callback) => scheduled.push(callback));
    expect(state.focused).toBe(1);
    expect(scheduled).toHaveLength(0);
  });

  it("focuses the search input once a lazily mounted page provides it", () => {
    const state: SearchDocumentState = { mounted: false, focused: 0 };
    const scheduled: (() => void)[] = [];
    focusSearchInputWhenReady(fakeDocument(state), (callback) => scheduled.push(callback));
    expect(state.focused).toBe(0);
    expect(scheduled).toHaveLength(1);
    state.mounted = true;
    while (scheduled.length > 0) scheduled.shift()?.();
    expect(state.focused).toBe(1);
  });

  it("stops retrying when the search input never mounts", () => {
    const state: SearchDocumentState = { mounted: false, focused: 0 };
    const scheduled: (() => void)[] = [];
    focusSearchInputWhenReady(fakeDocument(state), (callback) => scheduled.push(callback), 3);
    for (let round = 0; round < 5; round += 1) scheduled.shift()?.();
    expect(state.focused).toBe(0);
    expect(scheduled).toHaveLength(0);
  });

  it("reports a miss when the search input is absent", () => {
    expect(focusSearchInput(fakeDocument({ mounted: false, focused: 0 }))).toBe(false);
  });
});
