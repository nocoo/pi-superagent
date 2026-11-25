export const searchInputSelector = 'input[aria-label="搜索"]';

export interface SearchShortcutEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
}

export function isSearchShortcut(event: SearchShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

export interface FocusableElement {
  focus: () => void;
}

export interface SearchFocusDocument {
  querySelector: (selector: string) => FocusableElement | null;
}

export function focusSearchInput(doc: SearchFocusDocument): boolean {
  const input = doc.querySelector(searchInputSelector);
  if (!input) return false;
  input.focus();
  return true;
}

export function focusSearchInputWhenReady(
  doc: SearchFocusDocument,
  schedule: (callback: () => void) => void,
  attempts = 30,
): void {
  if (focusSearchInput(doc)) return;
  let remaining = attempts;
  const attempt = () => {
    if (focusSearchInput(doc)) return;
    if (remaining <= 0) return;
    remaining -= 1;
    schedule(attempt);
  };
  schedule(attempt);
}
