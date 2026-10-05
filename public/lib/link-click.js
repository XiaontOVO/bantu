/** True only for an ordinary primary-button activation of a link. */
export function isUnmodifiedPrimaryClick(event) {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}
