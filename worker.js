// ============================================================
// ENG_TRAINER — Cloudflare Worker
// วาง code นี้ทั้งหมดใน Cloudflare Worker Editor
// ============================================================
// Environment Variables ที่ต้องตั้งใน Dashboard:
//   GEMINI_API_KEY  → Google AI Studio API Key (Secret)
//   ADMIN_PASSWORD  → รหัสผ่าน Admin (Secret)
//   LESSONS_KV      → KV Namespace Binding
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password, X-Gemini-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function checkAdmin(request, env) {
  const pw = request.headers.get("X-Admin-Password");
  return pw === env.ADMIN_PASSWORD;
}

// ── Generate lesson via Gemini ────────────────────────────────
async function generateLesson(topic, difficulty, env, request) {
  const geminiKey = request.headers.get("X-Gemini-Key") || env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error("ไม่มี Gemini API Key — กรุณาใส่ key ในหน้า login");
  const difficultyGuide =
    difficulty === "B2"
      ? "advanced vocabulary, complex sentence structures, abstract topics"
      : "intermediate vocabulary, clear sentence structures, everyday topics";

  const topicInstruction = topic
    ? `The lesson topic must be: "${topic}".`
    : `Choose an interesting, varied topic suitable for ${difficulty} English learners. Pick from: travel, technology, science, culture, food, environment, health, history, business, art — but vary it each time.`;

  const prompt = `You are an English lesson creator for Thai learners at CEFR level ${difficulty}.

${topicInstruction}

Create a complete English lesson as a JSON object. Requirements:
- article: 90-100 words, clear and engaging, ${difficultyGuide}
- vocabulary: exactly 8 words/phrases taken directly from the article, with Thai meaning and one example sentence each
- questions: exactly 4 multiple-choice questions testing comprehension and vocabulary, each with 4 options (A/B/C/D), correct answer key, and a brief explanation in Thai

Return ONLY a valid JSON object — no markdown, no explanation, no code fences. The JSON must follow this exact structure:

{
  "topic": "string",
  "difficulty": "${difficulty}",
  "article": "string (90-100 words)",
  "vocabulary": [
    {
      "word": "string",
      "meaning": "string (Thai)",
      "example": "string (English sentence)"
    }
  ],
  "questions": [
    {
      "question": "string",
      "options": {
        "A": "string",
        "B": "string",
        "C": "string",
        "D": "string"
      },
      "answer": "A",
      "explanation": "string (Thai)"
    }
  ]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status} — ${errText}`);
  }

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned empty response");

  // Strip markdown fences if model misbehaves
  const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(clean);
}

// ── KV Helpers ────────────────────────────────────────────────
async function getIndex(env) {
  const raw = await env.LESSONS_KV.get("lessons:index");
  return raw ? JSON.parse(raw) : [];
}

async function saveIndex(index, env) {
  await env.LESSONS_KV.put("lessons:index", JSON.stringify(index));
}

// ── Route Handler ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Preflight CORS
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── GET /lessons ─────────────────────────────────────────
    if (method === "GET" && path === "/lessons") {
      const index = await getIndex(env);
      // Return lightweight list (id + topic + difficulty + created_at)
      const list = await Promise.all(
        index.map(async (id) => {
          const raw = await env.LESSONS_KV.get(`lessons:${id}`);
          if (!raw) return null;
          const lesson = JSON.parse(raw);
          return {
            id: lesson.id,
            topic: lesson.topic,
            difficulty: lesson.difficulty,
            created_at: lesson.created_at,
          };
        })
      );
      return json(list.filter(Boolean));
    }

    // ── GET /lessons/:id ──────────────────────────────────────
    const lessonMatch = path.match(/^\/lessons\/([a-z0-9_-]+)$/i);
    if (method === "GET" && lessonMatch) {
      const id = lessonMatch[1];
      const raw = await env.LESSONS_KV.get(`lessons:${id}`);
      if (!raw) return err("Lesson not found", 404);
      return json(JSON.parse(raw));
    }

    // ── POST /generate ────────────────────────────────────────
    if (method === "POST" && path === "/generate") {
      if (!checkAdmin(request, env)) return err("Unauthorized", 401);

      let body = {};
      try {
        body = await request.json();
      } catch {}

      const topic = body.topic?.trim() || "";
      const difficulty = body.difficulty === "B2" ? "B2" : "B1";

      let lessonData;
      try {
        lessonData = await generateLesson(topic, difficulty, env, request);
      } catch (e) {
        return err(`Generation failed: ${e.message}`, 500);
      }

      // Assign unique ID
      const index = await getIndex(env);
      const num = String(index.length + 1).padStart(3, "0");
      const id = `lesson_${num}`;

      const lesson = {
        id,
        ...lessonData,
        created_at: new Date().toISOString(),
      };

      await env.LESSONS_KV.put(`lessons:${id}`, JSON.stringify(lesson));
      index.push(id);
      await saveIndex(index, env);

      return json({ success: true, lesson });
    }

    // ── POST /lessons (manual create) ─────────────────────────
    if (method === "POST" && path === "/lessons") {
      if (!checkAdmin(request, env)) return err("Unauthorized", 401);

      let lesson;
      try {
        lesson = await request.json();
      } catch {
        return err("Invalid JSON body");
      }

      const index = await getIndex(env);
      const num = String(index.length + 1).padStart(3, "0");
      const id = lesson.id || `lesson_${num}`;
      lesson.id = id;
      lesson.created_at = lesson.created_at || new Date().toISOString();

      await env.LESSONS_KV.put(`lessons:${id}`, JSON.stringify(lesson));
      if (!index.includes(id)) {
        index.push(id);
        await saveIndex(index, env);
      }

      return json({ success: true, lesson });
    }

    // ── DELETE /lessons/:id ───────────────────────────────────
    if (method === "DELETE" && lessonMatch) {
      if (!checkAdmin(request, env)) return err("Unauthorized", 401);
      const id = lessonMatch[1];

      await env.LESSONS_KV.delete(`lessons:${id}`);
      const index = await getIndex(env);
      const updated = index.filter((x) => x !== id);
      await saveIndex(updated, env);

      return json({ success: true, deleted: id });
    }

    return err("Not found", 404);
  },
};
