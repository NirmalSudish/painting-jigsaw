// Famous public-domain paintings, bundled locally in /assets so the app makes
// zero external requests — required for it to work inside a Discord Activity
// (which proxies/blocks outbound network). Source: Wikimedia Commons (PD).

export const PAINTINGS = [
  { title: "Mona Lisa",                    artist: "da Vinci",     url: "assets/mona-lisa.jpg" },
  { title: "The Starry Night",             artist: "van Gogh",     url: "assets/starry-night.jpg" },
  { title: "Girl with a Pearl Earring",    artist: "Vermeer",      url: "assets/girl-pearl.jpg" },
  { title: "The Great Wave",               artist: "Hokusai",      url: "assets/great-wave.jpg" },
  { title: "American Gothic",              artist: "Grant Wood",   url: "assets/american-gothic.jpg" },
  { title: "The Kiss",                     artist: "Klimt",        url: "assets/the-kiss.jpg" },
  { title: "A Sunday on La Grande Jatte",  artist: "Seurat",       url: "assets/la-grande-jatte.jpg" },
  { title: "Wanderer above the Sea of Fog", artist: "Friedrich",   url: "assets/wanderer.jpg" },
];

// Difficulty presets -> grid layouts. Kept near-square per painting via main.js.
export const PIECE_PRESETS = [
  { label: "Easy",   pieces: 12 },
  { label: "Casual", pieces: 24 },
  { label: "Normal", pieces: 48 },
  { label: "Hard",   pieces: 96 },
  { label: "Expert", pieces: 192 },
];
