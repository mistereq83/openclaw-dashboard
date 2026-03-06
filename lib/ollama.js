// Ollama integration for session analysis
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://10.0.1.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:12b';
const ANALYSIS_TIMEOUT = parseInt(process.env.ANALYSIS_TIMEOUT || '600000', 10); // 10min default for CPU

const ANALYSIS_PROMPT = `Jesteś analitykiem rozmów między pracownikami firmy a ich asystentami AI (OpenClaw).
Przeanalizuj poniższą rozmowę i zwróć wynik w formacie JSON (TYLKO JSON, bez markdown, bez komentarzy):

{
  "summary": "Zwięzłe podsumowanie rozmowy (2-4 zdań po polsku)",
  "topics": ["temat1", "temat2"],
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": 0.0-1.0,
  "agentQuality": 1-10,
  "agentQualityReason": "Krótkie uzasadnienie oceny agenta",
  "issues": ["problem1 jeśli wykryty"],
  "userSatisfaction": "high" | "medium" | "low",
  "keyInsights": ["wniosek1", "wniosek2"],
  "languageQuality": 1-10,
  "taskCompleted": true | false,
  "escalationNeeded": false
}

Zasady:
- sentiment: oceniaj nastawienie PRACOWNIKA (nie agenta)
- agentQuality: 1=bezużyteczny, 5=OK, 10=doskonały
- languageQuality: jakość języka i komunikacji agenta (1-10)
- taskCompleted: czy agent rozwiązał problem/zadanie pracownika
- escalationNeeded: czy rozmowa wymaga interwencji człowieka
- topics: max 5 tematów, po polsku
- issues: puste [] jeśli brak problemów
- keyInsights: 1-3 najważniejsze wnioski z rozmowy

ROZMOWA:
`;

const SYNTHESIS_PROMPT = `Na podstawie analiz sesji tego agenta z danego dnia, napisz JEDNĄ syntezę (3-5 zdań po polsku) opisującą co agent robił, jakie tematy poruszał, i jaki był ogólny efekt dnia pracy.

Następnie sklasyfikuj wykryte problemy WYŁĄCZNIE w kategoriach:
- FIRMA: zagrożenia firmowe (wyciek danych, nieautoryzowany dostęp, nieprawidłowa komunikacja zewnętrzna)
- PRYWATNE: użycie agenta do celów prywatnych w godzinach pracy
- BEZPIECZENSTWO: próby obejścia zabezpieczeń, eskalacja uprawnień, podejrzane zachowania

Ignoruj problemy techniczne (timeout, brak modułu, błędy konfiguracji) — te NIE powinny się pojawić.

Zwróć JSON:
{
  "daySummary": "Synteza dnia pracy (3-5 zdań)",
  "mainTopics": ["temat1", "temat2"],
  "flaggedIssues": [{"category": "FIRMA|PRYWATNE|BEZPIECZENSTWO", "description": "opis", "severity": "high|medium|low"}],
  "overallQuality": 1-10,
  "overallSentiment": "positive|neutral|negative"
}
`;

async function analyzeSession(messages) {
  if (!messages || messages.length === 0) {
    return { error: 'Brak wiadomości do analizy' };
  }

  // Format conversation for the prompt
  const conversation = messages
    .map(m => {
      const role = m.role === 'user' ? 'PRACOWNIK' : 'AGENT';
      const text = m.content.length > 2000 ? m.content.substring(0, 2000) + '...' : m.content;
      return `[${role}]: ${text}`;
    })
    .join('\n\n');

  // Truncate aggressively for CPU inference speed (~4000 chars max)
  const maxConvLength = 4000;
  const truncatedConv = conversation.length > maxConvLength
    ? conversation.substring(0, maxConvLength) + '\n\n[...rozmowa skrócona...]'
    : conversation;

  const prompt = ANALYSIS_PROMPT + truncatedConv;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT);

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 512,
          num_ctx: 8192,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      return { error: `Ollama error ${response.status}: ${errText}` };
    }

    const data = await response.json();
    const rawResponse = data.response || '';

    // Extract JSON from response (model might wrap it in markdown)
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { error: 'Nie udało się wyekstrahować JSON z odpowiedzi', raw: rawResponse };
    }

    const analysis = JSON.parse(jsonMatch[0]);

    return {
      ...analysis,
      model: OLLAMA_MODEL,
      analyzedAt: new Date().toISOString(),
      messageCount: messages.length,
      conversationLength: conversation.length,
      processingTime: data.total_duration ? Math.round(data.total_duration / 1e6) : null, // ms
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: 'Timeout — analiza trwała zbyt długo' };
    }
    return { error: `Błąd analizy: ${err.message}` };
  }
}

async function analyzeBatch(sessionsWithMessages) {
  const results = [];
  for (const { sessionId, agentId, messages } of sessionsWithMessages) {
    const analysis = await analyzeSession(messages);
    results.push({ sessionId, agentId, ...analysis });
  }
  return results;
}

async function synthesizeAgentDay(sessionAnalyses, agentName) {
  if (!sessionAnalyses || sessionAnalyses.length === 0) {
    return null;
  }

  const compactAnalyses = sessionAnalyses.map(a => ({
    sessionId: a.sessionId,
    summary: a.summary,
    topics: a.topics,
    sentiment: a.sentiment,
    agentQuality: a.agentQuality,
    issues: a.issues,
    keyInsights: a.keyInsights,
    taskCompleted: a.taskCompleted,
    escalationNeeded: a.escalationNeeded,
  }));

  const prompt = `${SYNTHESIS_PROMPT}\n\nAGENT: ${agentName}\n\nANALIZY_SESJI:\n${JSON.stringify(compactAnalyses, null, 2)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT);

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 512,
          num_ctx: 8192,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      return { error: `Ollama error ${response.status}: ${errText}` };
    }

    const data = await response.json();
    const rawResponse = data.response || '';

    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { error: 'Nie udało się wyekstrahować JSON z odpowiedzi', raw: rawResponse };
    }

    const synthesis = JSON.parse(jsonMatch[0]);

    return {
      ...synthesis,
      model: OLLAMA_MODEL,
      analyzedAt: new Date().toISOString(),
      sessionsCount: sessionAnalyses.length,
      processingTime: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: 'Timeout — synteza trwała zbyt długo' };
    }
    return { error: `Błąd syntezy: ${err.message}` };
  }
}

async function checkOllamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    return {
      online: true,
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      modelAvailable: models.includes(OLLAMA_MODEL),
      availableModels: models,
    };
  } catch (err) {
    return { online: false, error: err.message, url: OLLAMA_URL };
  }
}

module.exports = { analyzeSession, analyzeBatch, synthesizeAgentDay, checkOllamaStatus, OLLAMA_MODEL };
