export const USER_PROFILE_FILE = "USER.md";
export const USER_PROFILE_MAX_CHARS = 4_000;

/** Count Unicode code points rather than UTF-16 code units, so emoji/surrogate pairs count as one character. */
export const userProfileLength = (value: string) => Array.from(value).length;
export const truncateUserProfile = (value: string, maxChars: number) => Array.from(value).slice(0, Math.max(0, maxChars)).join("");
