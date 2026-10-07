// Génère le fichier d'actualité du jour avec Claude (API + recherche web).
// Node 20+. Variable d'environnement requise : ANTHROPIC_API_KEY
// Produit docs/brouillon.json (contenu proposé) et resume.md (à relire avant validation).
import fs from 'node:fs';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5'; // vérifier le nom du modèle sur docs.claude.com
const FAMS = ['RN', 'CD', 'LFI', 'SD', 'REN', 'LR', 'ECO'];
if (!KEY) { console.error('ANTHROPIC_API_KEY manquante'); process.exit(1); }

const prev = JSON.parse(fs.readFileSync('docs/actu.json', 'utf8'));
const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });

const prompt = `Tu prépares le contenu quotidien du jeu mobile « Qui veut être Président ? », un jeu de simulation de la présidentielle française 2027 (premier tour le 18 avril 2027).
Nous sommes le ${today}. Utilise la recherche web pour t'appuyer UNIQUEMENT sur des faits vérifiables publiés ces derniers jours par des médias reconnus.

RÈGLES IMPÉRATIVES
- Les candidats du jeu sont FICTIFS et représentent des familles politiques : RN = droite nationale, CD = centre-droit, LFI = gauche radicale, SD = gauche sociale-démocrate, REN = bloc présidentiel, LR = droite républicaine, ECO = écologistes.
- Dans les textes (title, context, label, hint), ne nomme AUCUNE personnalité politique réelle et ne lui attribue aucun propos. Tu peux citer des institutions (gouvernement, Assemblée, Sénat, syndicats).
- Reste strictement neutre : chaque événement propose 3 choix contrastés, aucun présenté comme moralement supérieur.
- N'invente aucun chiffre ni aucun fait. En cas de doute, n'utilise pas l'information.

À PRODUIRE
1. polls : intentions de vote les plus récentes (moyenne ou agrégateur de sondages) ramenées à ces 7 familles, en %, et trend = évolution récente en points (entre -3 et 3). Pour une famille sans sondage clair, garde la valeur précédente.
2. events : 7 événements tirés de l'actualité réelle des derniers jours, du plus récent au plus ancien, chacun avec un champ date (ex. « 8 oct. 2026 »).
3. projections : 3 événements plausibles pour les mois suivants (décembre à mars), prolongeant les tendances du jour, sans champ date.
4. sources : liste des URL utilisées (pour relecture humaine, non affichée dans le jeu).

Pour chaque choix :
- base = effet en points par segment (J jeunes, P classes populaires, M classes moyennes et cadres, R retraités), entre -3 et 3
- aff = cohérence du choix avec chaque famille (RN, CD, LFI, SD, REN, LR, ECO), entre -1 (reniement) et 1.5 (parfaitement cohérent)
- cost = coût en M€ entre 0 et 3
- later (facultatif, au plus un choix sur deux) = conséquence à retardement {k: étapes plus tard (1 à 3), t: phrase, base: {J,P,M,R} entre -2 et 2}

Voici le fichier de la veille, qui donne le format EXACT attendu :
${JSON.stringify(prev)}

Réponds UNIQUEMENT avec le JSON complet du jour, au même format (champs maj, polls{source,v,trend}, events, projections, sources), maj = "${today}". Aucun texte avant ou après.`;

async function callClaude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }], messages })
  });
  if (!r.ok) throw new Error(`API ${r.status} : ${await r.text()}`);
  return r.json();
}

let messages = [{ role: 'user', content: prompt }], data, text = '';
for (let i = 0; i < 4; i++) {
  data = await callClaude(messages);
  text += data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (data.stop_reason !== 'pause_turn') break;
  messages = [...messages, { role: 'assistant', content: data.content }];
}

const raw = text.replace(/```json|```/g, '');
const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

// ---- Contrôles ----
const errs = [];
const num = (x, a, b) => typeof x === 'number' && x >= a && x <= b;
if (!json.polls || !FAMS.every(f => num(json.polls.v?.[f], 0.5, 60))) errs.push('sondages incomplets');
const checkEv = (e, i, kind) => {
  if (!e.title || !e.context || !Array.isArray(e.choices) || e.choices.length !== 3) return errs.push(`${kind} ${i + 1} : structure`);
  e.choices.forEach((c, j) => {
    if (!c.label || !['J', 'P', 'M', 'R'].every(k => num(c.base?.[k], -3, 3))) errs.push(`${kind} ${i + 1} choix ${j + 1} : base`);
    if (!FAMS.every(f => num(c.aff?.[f], -1, 1.5))) errs.push(`${kind} ${i + 1} choix ${j + 1} : aff`);
  });
};
(json.events || []).forEach((e, i) => checkEv(e, i, 'événement'));
(json.projections || []).forEach((e, i) => checkEv(e, i, 'projection'));
if ((json.events || []).length < 3) errs.push('moins de 3 événements');
if ((json.projections || []).length < 2) errs.push('moins de 2 projections');
if (errs.length) { console.error('Contenu refusé :\n- ' + errs.join('\n- ')); process.exit(1); }

json.maj = today;
fs.writeFileSync('docs/brouillon.json', JSON.stringify(json, null, 1));

// ---- Résumé à relire avant validation ----
let md = `## Actualité proposée pour le ${today}\n\n### Sondages\n| Famille | % | Tendance |\n|---|---|---|\n`;
for (const f of FAMS) md += `| ${f} | ${json.polls.v[f]} | ${json.polls.trend?.[f] ?? 0} |\n`;
md += `\n### Événements\n`;
for (const e of json.events) md += `\n**${e.date || ''} — ${e.title}**\n\n${e.context}\n\n${e.choices.map(c => `- ${c.label}`).join('\n')}\n`;
md += `\n### Projections\n`;
for (const e of json.projections) md += `\n**${e.title}** — ${e.context}\n`;
md += `\n### Sources\n${(json.sources || []).map(u => `- ${u}`).join('\n')}\n`;
fs.writeFileSync('resume.md', md);
console.log('Brouillon prêt : docs/brouillon.json');
