/**
 * Keeps the bell in the top bar in step with changes made elsewhere on the
 * page (the /notifications list), without waiting for its next poll:
 *
 *     announceNotificationsChanged();                  // after marking or dismissing
 *     useEffect(() => onNotificationsChanged(refresh), [refresh]);
 *
 * A plain window event: the bell and the list live in different React trees
 * (the bell is under the server-rendered top nav), so no context reaches both.
 */

const EVENT = "flabsheet:notifications-changed";

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** Subscribe; returns the unsubscribe function, so it can be an effect's cleanup. */
export function onNotificationsChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
