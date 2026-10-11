// Regression test: the de/fr/es translations in js/locales/overrides.js were
// authored ASCII-only, stripping every umlaut/accent ("Radiergrosse",
// "Demarrer", "Configuracion"), and — because overrides are merged ON TOP of
// the locale files — the mangled strings even shadowed correct values already
// present in de-DE.js/fr-FR.js/es-ES.js. This test keeps the repaired
// diacritics in place: a known-mangled-word blacklist must stay absent from
// the German/French/Spanish override trees, and spot-checked values must keep
// their correct spellings.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOverrides() {
  const sandbox = { window: {}, console: { warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'locales', 'overrides.js'), 'utf8'),
    sandbox,
    { filename: 'overrides.js' }
  );
  return sandbox.window.locale_translation_overrides;
}

// Words that only ever appear when diacritics were stripped. Word-boundary
// matched so legitimate words containing them as substrings stay allowed.
const MANGLED_WORDS = [
  // German: lost umlauts / ß. "Gestion"/"Detectar" etc. are legitimate words
  // in some of these languages and must NOT be blacklisted; every entry here
  // is unambiguous across de/fr/es.
  'grosse', 'Grosse', 'moglich', 'Moglich', 'Wahle', 'fur {', 'farben fur', 'Zuruck', 'hinzufugen',
  'erhohen', 'unterstutzt', 'Unterstutzt', 'gultigen', 'auswahlen', 'Schaltflachen',
  'Standardmassig', 'verfugbar', 'bestatigen', 'prufe', 'ausgelost', 'Punktestande',
  // French: lost accents
  'Demarrer', 'Arreter', 'Apercu', 'Parametres', 'Opacite', 'Echec', 'Reglez',
  'Selecteur', 'Reinitialiser', 'arriere', 'deplacement', 'libelles', 'prete',
  'illimite', 'systeme', 'entree', 'donnee', 'Televerser', 'Epaisseur', 'Verifiez',
  'ecran', 'equipe', 'Equipe', 'differences', 'repetitions', 'succes',
  // Spanish: lost tildes
  'Configuracion', 'Tamano', 'lapiz', 'tactil', 'Guias', 'activalo', 'numerico',
  'Minimo', 'Maximo', 'pagina', 'paginas', 'funcion', 'titulo', 'Titulo', 'rapida',
  'automaticamente', 'validos', 'visualizacion', 'importacion', 'actualizacion',
  'como aplicar', 'este lista'
];

function collectStringValues(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object' && !Array.isArray(node)) {
    Object.values(node).forEach((value) => collectStringValues(value, out));
  }
  return out;
}

function testNoMangledWordsRemain() {
  const overrides = loadOverrides();
  for (const locale of ['de-DE', 'fr-FR', 'es-ES']) {
    const strings = collectStringValues(overrides[locale]);
    assert.ok(strings.length > 100, `${locale} overrides must contain a meaningful body of strings`);
    for (const value of strings) {
      for (const word of MANGLED_WORDS) {
        // Match with a word-ish boundary so e.g. "fur" doesn't hit "furieux";
        // the blacklist itself only contains standalone mangled words.
        const pattern = new RegExp(`(^|[^a-zA-Zà-ÿÀ-ß])${word.replace(/ /g, '\\s')}([^a-zA-Zà-ÿÀ-ß]|$)`);
        assert.ok(
          !pattern.test(value),
          `${locale} value ${JSON.stringify(value)} still contains the mangled word "${word}"`
        );
      }
    }
  }
}

function testSpotCheckedValues() {
  const overrides = loadOverrides();

  assert.equal(overrides['de-DE'].tools.eraser.sizeLabel, 'Radiergröße: Aktuell',
    'German eraser size label must keep its ß');
  assert.equal(overrides['de-DE'].timer.timeFontSize, 'Schriftgröße der Uhrzeit',
    'German timer font size must not read as "magazine size" (Zeitschrift)');
  assert.equal(overrides['de-DE'].settings.time.fullscreenModeHint,
    'Wählen Sie, wie der Vollbildmodus ausgelöst wird',
    'German settings hints must use Sie-form with umlauts');
  assert.equal(overrides['fr-FR'].common.start, 'Démarrer',
    'French "start" must keep its accent');
  assert.equal(overrides['fr-FR'].scoreboard.teamDefault, 'Équipe',
    'French "team" must keep its accent');
  assert.equal(overrides['fr-FR'].timer.setTime, "Définir l'heure",
    'French timer labels must keep their accents');
  assert.equal(overrides['es-ES'].common.settings, 'Configuración',
    'Spanish "settings" must keep its tilde');
  assert.equal(overrides['es-ES'].timer.titleFontSize, 'Tamaño de fuente del título',
    'Spanish timer font size must keep its tildes (and must shadow-check cleanly)');

  // The override values must no longer be WORSE than the main locale files
  // they shadow: fr/es main files already had correct font-size labels, so the
  // overrides merged on top must match that quality bar.
  const mainLocale = (locale) => {
    const sandbox = { window: {}, console: { warn() {} } };
    vm.createContext(sandbox);
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', 'js', 'locales', `${locale}.js`), 'utf8'),
      sandbox,
      { filename: `${locale}.js` }
    );
    return sandbox.window.translations;
  };
  assert.equal(overrides['es-ES'].timeDisplay.titleFontSize, 'Tamaño de fuente del título',
    'the es-ES override shadowing the main file must be correctly spelled too');
  assert.ok(mainLocale('es-ES').timer.titleFontSize.includes('Tamaño'),
    'sanity: the main es-ES file carries the correct spelling');
}

function main() {
  testNoMangledWordsRemain();
  testSpotCheckedValues();
  console.log('locale-overrides-diacritics.test: all assertions passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
