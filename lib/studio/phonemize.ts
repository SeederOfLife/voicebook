// Text → phonemes for the Kokoro voice model.
// Ported from kokoro.js (https://github.com/hexgrad/kokoro, Apache-2.0), so the
// studio voice pronounces text exactly like the reference implementation.
import { phonemize as espeakng } from "phonemizer";

/** Split a string on a regex, keeping the delimiters. */
function split(text: string, regex: RegExp): { match: boolean; text: string }[] {
  const result: { match: boolean; text: string }[] = [];
  let prev = 0;
  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    const index = match.index ?? 0;
    if (prev < index) result.push({ match: false, text: text.slice(prev, index) });
    if (fullMatch.length > 0) result.push({ match: true, text: fullMatch });
    prev = index + fullMatch.length;
  }
  if (prev < text.length) result.push({ match: false, text: text.slice(prev) });
  return result;
}

/** "1984" → "19 84", "7:05" → "7 oh 5" */
function splitNum(match: string): string {
  if (match.includes(".")) return match;
  if (match.includes(":")) {
    const [h, m] = match.split(":").map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

/** "$3.50" → "3 dollars and 50 cents" */
function flipMoney(match: string): string {
  const bill = match[0] === "$" ? "dollar" : "pound";
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes(".")) return `${match.slice(1)} ${bill}${match.slice(1) === "1" ? "" : "s"}`;
  const [b, c] = match.slice(1).split(".");
  const d = parseInt(c.padEnd(2, "0"), 10);
  const coins = match[0] === "$" ? (d === 1 ? "cent" : "cents") : d === 1 ? "penny" : "pence";
  return `${b} ${bill}${b === "1" ? "" : "s"} and ${d} ${coins}`;
}

/** "3.14" → "3 point 1 4" */
function pointNum(match: string): string {
  const [a, b] = match.split(".");
  return `${a} point ${b.split("").join(" ")}`;
}

function normalizeText(text: string): string {
  return (
    text
      // 1. Quotes and brackets
      .replace(/[‘’]/g, "'")
      .replace(/«/g, "“")
      .replace(/»/g, "”")
      .replace(/[“”]/g, '"')
      .replace(/\(/g, "«")
      .replace(/\)/g, "»")
      // 2. Uncommon punctuation
      .replace(/、/g, ", ")
      .replace(/。/g, ". ")
      .replace(/！/g, "! ")
      .replace(/，/g, ", ")
      .replace(/：/g, ": ")
      .replace(/；/g, "; ")
      .replace(/？/g, "? ")
      // 3. Whitespace
      .replace(/[^\S \n]/g, " ")
      .replace(/  +/g, " ")
      .replace(/(?<=\n) +(?=\n)/g, "")
      // 4. Abbreviations
      .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
      .replace(/\betc\.(?! [A-Z])/gi, "etc")
      // 5. Casual words
      .replace(/\b(y)eah?\b/gi, "$1e'a")
      // 6. Numbers and currencies
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
      .replace(/(?<=\d),(?=\d)/g, "")
      .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
      .replace(/\d*\.\d+/g, pointNum)
      .replace(/(?<=\d)-(?=\d)/g, " to ")
      .replace(/(?<=\d)S/g, " S")
      // 7. Possessives
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, "s")
      // 8. Initialisms
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
      .trim()
  );
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`, "g");

/**
 * Phonemize English text.
 * @param language "a" = American English, "b" = British English
 */
export async function phonemize(text: string, language: "a" | "b" = "a"): Promise<string> {
  const sections = split(normalizeText(text), PUNCTUATION_PATTERN);
  const lang = language === "a" ? "en-us" : "en";
  const parts = await Promise.all(
    sections.map(async ({ match, text }) => (match ? text : (await espeakng(text, lang)).join(" "))),
  );

  let processed = parts
    .join("")
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");

  if (language === "a") processed = processed.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return processed.trim();
}
