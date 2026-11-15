/**
 * Whether a string has a control character in it: C0 and C1 controls, DEL, and the two line
 * separators of Unicode. A name with one of them in it cannot be put in a fact, and could be used to
 * make a line of a log or of a prompt read as another. It is a loop and not a regular expression,
 * which would have the characters written in it.
 */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}
