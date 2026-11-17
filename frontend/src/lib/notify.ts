import { toast } from "sonner";

/**
 * Toasts for the result of something the user did (the <Toaster /> is mounted
 * in app/layout.tsx):
 *
 *     notifySuccess("Saved.");
 *     try { await save(); } catch (err) { notifyError(toMessage(err)); }
 *
 * `notifyError` takes the nullable message of `useApiError()` and shows
 * nothing for null (a redirect to the login page has started). Validation
 * errors of a form and errors loading a page stay inline (`<FormError>`):
 * they must remain on screen until the user fixes them.
 */
export function notifyError(message: string | null): void {
  if (message) toast.error(message);
}

export function notifySuccess(message: string): void {
  toast.success(message);
}

/** For something that happened without a click, such as judging finishing. */
export function notifyInfo(message: string): void {
  toast.info(message);
}
