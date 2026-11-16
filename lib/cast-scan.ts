// Pre-scan of a whole book, done on the device when the book is opened (no AI key
// needed): finds who speaks, guesses whether each is a man, a woman or a child,
// and counts how often they speak. The same clues are then used, part by part, to
// tell which character says each line.
import type { Age, Character, Gender } from "./types";

const VERBS =
  "said|says|asked|asks|replied|replies|answered|whispered|shouted|cried|muttered|murmured|called|yelled|exclaimed|snapped|added|continued|insisted|began|laughed|sighed|breathed|repeated|told|demanded|declared|growled|hissed|screamed|sobbed|stammered|suggested|admitted|agreed|warned|gasped|grumbled|protested|pleaded|whimpered|chuckled|interrupted|explained|announced|offered|observed|remarked|retorted|roared|wondered";
const TITLES = "Mr|Mrs|Ms|Miss|Dr|Sir|Lady|Lord|Captain|Uncle|Aunt|Professor|King|Queen|Prince|Princess|Father|Mother|Sister|Brother|Madame|Monsieur|Mister|Granny|Grandma|Grandpa|Detective|Inspector|Doctor|Officer|Master|Mistress";
const NAME = `(?:(?:${TITLES})\\.?\\s+)?[A-Z][a-z'’]+(?:\\s+[A-Z][a-z'’]+)?`;

// Capitalised words that are not names.
const NOT_NAMES = new Set(
  (
    "The A An He She It I We You They His Her Their Its My Our Your This That These Those There Here Then When Where What Why How Who " +
    "But And Or So Yet For Nor If As At By In On Of To Up From With Without After Before Into Over Under Again Still Just Even Only " +
    "Yes No Oh Ah Well Now Not Please Thank Thanks Okay Ok Hello Hi Hey Goodbye Sorry Mm Hmm Dear God Lord Sir Madam " +
    "Chapter Part Book Prologue Epilogue One Two Three Four Five Six Seven Eight Nine Ten " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December " +
    "English French German American British Christmas Mum Mom Dad Everyone Someone Nobody Something Nothing Everything Maybe Perhaps Of Once"
  ).split(" "),
);

const MALE_NAMES = new Set(
  "james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel frank gregory raymond alexander patrick jack dennis jerry tyler aaron henry adam peter nathan zachary walter kyle harold carl arthur gerald roger keith jeremy lawrence sean christian albert joe ethan austin jesse willie billy bryan bruce jordan ralph roy noah dylan eugene wayne alan juan louis russell gabriel randy philip harry vincent bobby johnny logan tom tim sam ben bob bill jim mike max leo luke oliver liam lucas mason elijah owen finn hugo felix oscar theo jake tom harry ron fred percy draco sirius remus severus albus neville hagrid frodo sam bilbo gandalf aragorn legolas gimli boromir pippin merry ahab ishmael sherlock watson holmes elias marco pierre jean jacques karel petr jan tomas martin luca matteo diego carlos pablo".split(" "),
);
const FEMALE_NAMES = new Set(
  "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa betty margaret sandra ashley kimberly emily donna michelle dorothy carol amanda melissa deborah stephanie rebecca sharon laura cynthia kathleen amy shirley angela helen anna brenda pamela nicole emma samantha katherine christine debra rachel catherine carolyn janet ruth maria heather diane virginia julie joyce victoria olivia kelly christina lauren joan evelyn judith megan cheryl andrea hannah martha jacqueline frances gloria ann teresa kathryn sara janice jean alice madison doris abigail julia judy grace denise amber marilyn beverly danielle theresa sophia marie diana brittany natalie isabella charlotte rose alexis kayla lily ella chloe zoe mia ava amelia harper ellie hermione ginny luna molly lucy susan arwen galadriel eowyn jane eliza elinor marianne lizzie jo meg beth amy anne marilla clara heidi alba elena sofia giulia chiara camille sophie claire manon lea eva tereza petra lenka jana marta lucia carmen isabel ines rosa nora iris ivy ruby violet hazel stella aurora".split(" "),
);
const MALE_TITLES = /^(Mr|Sir|Lord|Captain|Uncle|Professor|King|Prince|Father|Brother|Monsieur|Mister|Grandpa|Master)\b/;
const FEMALE_TITLES = /^(Mrs|Ms|Miss|Lady|Aunt|Queen|Princess|Mother|Sister|Madame|Granny|Grandma|Mistress)\b/;

export interface ScannedCharacter extends Character {
  lines: number;
}

export const QUOTES = `“[^”]{1,1500}”|"[^"\\n]{1,1500}"|«[^»]{1,1500}»|„[^“”]{1,1500}[“”]|(?<![\\p{L}\\p{N}])‘[^’\\n]{1,1500}?’(?![\\p{L}])|(?<![\\p{L}\\p{N}])'[^'\\n]{1,1500}?'(?![\\p{L}])`;
const quoteRe = new RegExp(QUOTES, "gu");
const nameRe = new RegExp(NAME, "g");
const ADJ = /^(Old|Young|Little|Poor|Dear|Good|Big|Small|Tall|Fat)\s+/;
const afterRe = new RegExp(`^\\s*,?\\s*(?:(?:[Tt]he\\s+)?(${NAME})\\s+(?:${VERBS})|(?:${VERBS})\\s+(?:the\\s+)?(${NAME}))\\b`);
const beforeRe = new RegExp(`(?:^|[.!?]\\s+|\\n)\\s*(${NAME})\\s+(?:${VERBS})[^.“"«„]{0,40}[,:]?\\s*$`);
const pronounAfter = new RegExp(`^\\s*,?\\s*(?:(he|she)\\s+(?:${VERBS})|(?:${VERBS})\\s+(he|she))\\b`, "i");

/** A real name (not "The", "Chapter"…), cleaned. */
function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/[’']s$/, "").replace(/\s+/g, " ").trim().replace(ADJ, "");
  const first = name.split(" ")[0].replace(/\.$/, "");
  if (NOT_NAMES.has(first) && !new RegExp(`^(${TITLES})$`).test(first)) return null;
  if (name.split(" ").every((w) => NOT_NAMES.has(w))) return null;
  return name.length >= 2 ? name : null;
}

/** Who says the quote that starts at `at` (ends at `end`) in `text`: a name, "he"/"she", or null. */
export function attribution(text: string, at: number, end: number): string | null {
  const after = text.slice(end, end + 70);
  const m = afterRe.exec(after);
  const n = cleanName(m?.[1] ?? m?.[2]);
  if (n) return n;
  const p = pronounAfter.exec(after);
  if (p) return (p[1] ?? p[2]).toLowerCase();
  const before = text.slice(Math.max(0, at - 90), at);
  const b = beforeRe.exec(before);
  return cleanName(b?.[1]);
}

function guessGender(name: string, text: string): Gender {
  if (MALE_TITLES.test(name)) return "male";
  if (FEMALE_TITLES.test(name)) return "female";
  const first = name.replace(new RegExp(`^(${TITLES})\\.?\\s+`), "").split(" ")[0].toLowerCase();
  if (MALE_NAMES.has(first)) return "male";
  if (FEMALE_NAMES.has(first)) return "female";
  // "Mr. Darcy" / "Miss Bingley" elsewhere in the book.
  const esc0 = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mr = (text.match(new RegExp(`\\b(?:Mr|Sir|Lord|Master|Mister)\\.?\\s+${esc0}\\b`, "g")) ?? []).length;
  const mrs = (text.match(new RegExp(`\\b(?:Mrs|Miss|Ms|Lady|Madame)\\.?\\s+${esc0}\\b`, "g")) ?? []).length;
  if (mr >= 2 && mr > mrs * 3) return "male";
  if (mrs >= 2 && mrs > mr * 3) return "female";
  // Pronouns that follow the name.
  let he = 0;
  let she = 0;
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b([^.!?]{0,120}[.!?][^.!?]{0,80})`, "g");
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) && n++ < 200) {
    he += (m[1].match(/\b(he|him|his|himself)\b/gi) ?? []).length;
    she += (m[1].match(/\b(she|her|hers|herself)\b/gi) ?? []).length;
  }
  if (he > she * 1.5 && he >= 2) return "male";
  if (she > he * 1.5 && she >= 2) return "female";
  return "neutral";
}

function guessAge(name: string, text: string): Age {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const near = new RegExp(`(?:\\b(little|young|old|elderly|tiny)\\s+${esc}\\b|\\b${esc}\\b,?\\s+(?:a|the|an)\\s+(?:\\w+\\s+)?(boy|girl|child|kid|baby|old man|old woman|grandmother|grandfather|teenager)\\b)`, "gi");
  let child = 0;
  let old = 0;
  let young = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = near.exec(text)) && n++ < 100) {
    const w = (m[1] ?? m[2] ?? "").toLowerCase();
    if (/little|small|tiny|boy|girl|child|kid|baby|toddler/.test(w)) child++;
    else if (/old|elderly|aged|grand|granny|grandpa/.test(w)) old++;
    else if (/young|teen/.test(w)) young++;
  }
  if (/^(Granny|Grandma|Grandpa)\b/.test(name)) return "elderly";
  const total = Math.max(1, (text.match(new RegExp(`\\b${esc}\\b`, "g")) ?? []).length);
  const enough = (k: number) => k >= 1 && k >= total * 0.03;
  if (enough(child) && child > old) return "child";
  if (enough(old) && old > child) return "elderly";
  if (enough(young) && young >= 2) return "young";
  return "adult";
}

/** The last name mentioned in the narration of the paragraph, before position `at`. */
function lastNameBefore(text: string, at: number): string | null {
  const start = Math.max(text.lastIndexOf("\n\n", at), at - 400, 0);
  const narration = text.slice(start, at).replace(quoteRe, " ");
  let last: string | null = null;
  for (const m of narration.matchAll(nameRe)) {
    // Skip a capitalised word that only starts a sentence ("Then", "Far"…): cleanName filters most.
    const n = cleanName(m[0]);
    if (n) last = n;
  }
  return last;
}

/** Scan the whole book for its speaking characters. Fast enough for a long novel (well under a second). */
export function scanCharacters(chunks: string[]): ScannedCharacter[] {
  const text = chunks.join("\n\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
  const speaks = new Map<string, number>();
  for (const q of text.matchAll(quoteRe)) {
    let who = attribution(text, q.index!, q.index! + q[0].length);
    if (who === "he" || who === "she") who = lastNameBefore(text, q.index!);
    if (who) speaks.set(who, (speaks.get(who) ?? 0) + 1);
  }
  // Merge "Elena Marsh" into "Elena" (or the reverse when only the full name is used).
  const names = [...speaks.keys()].sort((a, b) => a.length - b.length);
  const canonical = new Map<string, string>();
  const longer = (m: string) => names.filter((n) => n !== m && (n.startsWith(m + " ") || n.endsWith(" " + m)));
  for (const n of names) {
    // "Bennet" is not merged when both "Mr. Bennet" and "Mrs. Bennet" speak.
    const base = names.find((m) => m !== n && (n.startsWith(m + " ") || n.endsWith(" " + m)) && longer(m).length === 1);
    canonical.set(n, base ? canonical.get(base) ?? base : n);
  }
  const counts = new Map<string, number>();
  for (const [n, c] of speaks) {
    const k = canonical.get(n) ?? n;
    counts.set(k, (counts.get(k) ?? 0) + c);
  }
  // Keep names that are used like names (also appear mid-sentence) and speak more than once,
  // or once in a short text.
  const minLines = text.length > 40_000 ? 2 : 1;
  const found: ScannedCharacter[] = [];
  for (const [name, lines] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (lines < minLines) continue;
    found.push({ name, gender: guessGender(name, text), age: guessAge(name, text), lines });
    if (found.length >= 24) break;
  }
  return found;
}

/** The canonical character name for a name found in the text ("Elena Marsh" → "Elena"). */
export function matchCharacter(name: string, cast: Character[]): Character | undefined {
  const low = name.toLowerCase();
  return (
    cast.find((c) => c.name.toLowerCase() === low) ??
    cast.find((c) => low.startsWith(c.name.toLowerCase() + " ") || low.endsWith(" " + c.name.toLowerCase())) ??
    cast.find((c) => c.name.toLowerCase().startsWith(low + " ") || c.name.toLowerCase().endsWith(" " + low))
  );
}
