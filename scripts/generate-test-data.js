// Generate realistic test JSONL session data for all agents
const fs = require('fs');
const path = require('path');

const agents = ['patrykg', 'annag', 'paulinag', 'katarzynag', 'katarzynac'];
const baseDir = path.join(__dirname, '..', 'test-data', '.openclaw', 'agents');

const sampleTopics = [
  'raport sprzedażowy', 'analiza kosztów', 'oferta dla klienta',
  'plan marketingowy', 'przegląd budżetu', 'harmonogram projektu',
  'notatka ze spotkania', 'email do dostawcy', 'prezentacja Q1',
  'zamówienie materiałów', 'faktura VAT', 'umowa współpracy',
  'raport miesięczny', 'plan szkoleń', 'audyt wewnętrzny',
];

const sampleUserMessages = [
  'Przygotuj raport sprzedażowy za ostatni miesiąc.',
  'Napisz email do klienta z potwierdzeniem zamówienia.',
  'Zrób analizę kosztów dla projektu Alfa.',
  'Przygotuj ofertę handlową dla firmy XYZ.',
  'Sprawdź harmonogram dostaw na ten tydzień.',
  'Napisz notatkę ze spotkania z zarządem.',
  'Przygotuj prezentację wyników za Q1.',
  'Zaktualizuj bazę kontrahentów.',
  'Wygeneruj fakturę za usługi doradcze.',
  'Sprawdź status realizacji zamówień.',
  'Czy możesz przejrzeć umowę współpracy?',
  'Potrzebuję zestawienie kosztów operacyjnych.',
  'Zaplanuj spotkanie z zespołem na piątek.',
  'Przygotuj listę zadań na następny tydzień.',
  'Czy mamy aktualne dane kontaktowe dostawców?',
];

const sampleAssistantMessages = [
  'Przygotowałem raport. Oto podsumowanie: w ostatnim miesiącu sprzedaż wzrosła o 12% w stosunku do poprzedniego okresu. Główne kategorie to...',
  'Email został przygotowany. Zawiera potwierdzenie zamówienia nr 2024/0847 wraz ze szczegółami dostawy.',
  'Analiza kosztów projektu Alfa jest gotowa. Łączne koszty wynoszą 157,000 PLN, co stanowi 94% budżetu.',
  'Oferta handlowa dla XYZ została przygotowana. Obejmuje pakiet Premium z 15% rabatem.',
  'Harmonogram dostaw: 3 dostawy zaplanowane — poniedziałek, środa i piątek. Wszystkie potwierdzone.',
  'Notatka ze spotkania: omówiono wyniki Q4, zatwierdzono budżet na Q1, ustalono nowe priorytety.',
  'Prezentacja Q1 jest gotowa. Zawiera 15 slajdów z wykresami sprzedaży, kosztów i marży.',
  'Baza kontrahentów zaktualizowana. Dodano 7 nowych firm, usunięto 2 nieaktywne.',
  'Faktura FV/2024/0293 wygenerowana na kwotę 24,600 PLN brutto.',
  'Status zamówień: 12 w realizacji, 3 wysłane, 1 opóźnione (ZAM-847).',
  'Przejrzałem umowę. Znalazłem 3 punkty wymagające uwagi — dotyczą terminów płatności i kar umownych.',
  'Zestawienie gotowe. Koszty operacyjne w tym miesiącu: 89,400 PLN (budżet: 95,000 PLN).',
  'Spotkanie zaplanowane na piątek 14:00. Wysłano zaproszenia do 6 osób z zespołu.',
  'Lista zadań na przyszły tydzień: 14 pozycji, w tym 4 priorytetowe oznaczone jako pilne.',
  'Dane kontaktowe dostawców są aktualne. Ostatnia weryfikacja: 3 dni temu.',
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysBack) {
  const now = new Date();
  const past = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return new Date(past.getTime() + Math.random() * (now.getTime() - past.getTime()));
}

function generateSession(agentId, sessionDate) {
  const messages = [];
  const turnCount = randomInt(2, 8);
  let ts = new Date(sessionDate);

  for (let i = 0; i < turnCount; i++) {
    // User message
    ts = new Date(ts.getTime() + randomInt(10, 300) * 1000);
    messages.push({
      role: 'user',
      content: sampleUserMessages[randomInt(0, sampleUserMessages.length - 1)],
      timestamp: ts.toISOString(),
    });

    // Assistant message
    ts = new Date(ts.getTime() + randomInt(5, 60) * 1000);
    messages.push({
      role: 'assistant',
      content: sampleAssistantMessages[randomInt(0, sampleAssistantMessages.length - 1)],
      timestamp: ts.toISOString(),
      tokens: randomInt(100, 2000),
    });
  }

  return messages;
}

// Generate data
for (const agent of agents) {
  const sessionsDir = path.join(baseDir, agent, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Main session
  const mainMessages = generateSession(agent, randomDate(1));
  fs.writeFileSync(
    path.join(sessionsDir, 'main.jsonl'),
    mainMessages.map(m => JSON.stringify(m)).join('\n') + '\n'
  );

  // Random number of historical sessions (5-20 per agent)
  const sessionCount = randomInt(5, 20);
  for (let i = 0; i < sessionCount; i++) {
    const date = randomDate(30);
    const sessionId = `session-${date.toISOString().split('T')[0]}-${randomInt(1000, 9999)}`;
    const messages = generateSession(agent, date);
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    );
  }

  console.log(`Generated data for ${agent}: main + ${sessionCount} sessions`);
}

console.log('\nTest data generated in test-data/');
