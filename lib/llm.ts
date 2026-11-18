// One way to ask the AI for JSON, whichever key the server has:
//   GEMINI_API_KEY    – Google Gemini (free tier available at aistudio.google.com)
//   ANTHROPIC_API_KEY – Claude
// Gemini is used first when both are set (free).

export const aiProvider = (): "gemini" | "anthropic" | null =>
  process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null;

export class AiError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

function parseJson(out: string): unknown {
  const cleaned = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new AiError("the AI answer had no JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function gemini(system: string, user: string, maxTokens: number): Promise<string> {
  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const models = (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-2.5-flash").split(",").map((m) => m.trim()).filter(Boolean);
  let last = "";
  for (const model of models) {
    for (const thinking of [true, false]) {
      const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: maxTokens,
            temperature: 0.4,
            // No long "thinking": this is reading and labelling, and it keeps it fast.
            ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (text) return text;
        last = `empty answer (${data?.candidates?.[0]?.finishReason ?? "no reason"})`;
        break;
      }
      const detail = (await res.text()).slice(0, 300);
      last = `${model}: HTTP ${res.status} ${detail}`;
      if (res.status === 429) throw new AiError("the free AI allowance for now is used up (Gemini: try again in a minute)", 429);
      if (res.status === 400 && thinking && /thinking/i.test(detail)) continue; // model without that setting
      break; // try the next model
    }
  }
  console.error("Gemini error", last);
  throw new AiError("the AI (Gemini) didn't answer");
}

async function anthropic(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    console.error("Anthropic error", res.status, (await res.text()).slice(0, 300));
    throw new AiError(`AI analysis failed (${res.status})`);
  }
  const data = await res.json();
  return (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
}

/** Ask the AI and get its JSON answer back (parsed). */
export async function askJson(system: string, user: string, maxTokens = 8000): Promise<unknown> {
  const p = aiProvider();
  if (!p) throw new AiError("no AI key on the server", 501);
  const out = p === "gemini" ? await gemini(system, user, maxTokens) : await anthropic(system, user, maxTokens);
  return parseJson(out);
}
