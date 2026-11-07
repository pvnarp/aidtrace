// Fixed words for the receipt photo reader (IAC-384, docs/decisions.md orchestrator decisions D7). The server and the browser component both read them from here.
// No "verified", "approved" or "accurate": the person compares the form with the photo.
export const PHOTO_CONTROL_LABEL = "Read a photo of a sample receipt";
export const PHOTO_HINT = "JPEG, PNG or WebP, up to 3.75 MB. The photo is sent to the AI once to read it and is not kept. Use a photo of a sample receipt only.";
export const PHOTO_READ_NOTICE = "AI read this photo. Check every line against the photo before you continue.";
export const PHOTO_FAILED = "Could not read this photo. Type the receipt instead.";
export const PHOTO_PREVIEW_ALT = "The photo you chose, shown from your own browser";
export const centsToUsd = (cents: number): string => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
export const centsToInput = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
export const photoMismatch = (linesPlusTaxCents: number, totalCents: number): string =>
  `The amounts do not add up: lines plus tax are ${centsToUsd(linesPlusTaxCents)}, the total reads ${centsToUsd(totalCents)}. Fix the numbers or retake the photo.`;
// Lines plus tax match the total but a printed subtotal does not match the lines. Same shape, one more fixed sentence.
export const photoSubtotalMismatch = (linesCents: number, subtotalCents: number): string =>
  `The amounts do not add up: the lines are ${centsToUsd(linesCents)}, the subtotal reads ${centsToUsd(subtotalCents)}. Fix the numbers or retake the photo.`;
// IAC-384 (docs/ASSUMPTIONS.md section 87). The subtotal covers the first lines and the rest sit after it, inside the total (a tip added by hand). A neutral note, not a warning:
// it still sends the person to the photo. No "verified", "approved" or "accurate" (D7).
export const photoAfterSubtotal = (subtotalCents: number, printedCount: number, afterCents: number, totalCents: number): string =>
  `The subtotal ${centsToUsd(subtotalCents)} covers the first ${printedCount} ${printedCount === 1 ? "line" : "lines"}. The ${centsToUsd(afterCents)} after it, such as a tip added by hand, is in the total of ${centsToUsd(totalCents)}. Check that line against the photo.`;
// The claim page evidence line. modelLabel comes from the stored read row through the existing model label helper. unchanged is the server's own comparison of the saved
// values with what the read pre-filled (receipt_reviews.photo_unchanged). Category confirmation is a separate fact and is not in this line.
export const photoEvidenceLine = (modelLabel: string, unchanged: boolean): string =>
  unchanged ? `Pre-filled from a photo by ${modelLabel}. The claimant made no changes.` : `Pre-filled from a photo by ${modelLabel}, then changed by the claimant.`;
// Beside the date field when the photo's printed date is not a calendar date the form can hold. React text only: the printed date is the model's text and is never markup.
export const photoPrintedDate = (printed: string): string => `Printed date: ${printed}. Enter it as a date.`;
export const PHOTO_SOURCE_LABEL = "Receipt text read from the photo";
export const PHOTO_SOURCE_LABEL_TYPED = "Receipt text";
