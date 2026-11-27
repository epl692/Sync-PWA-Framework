/** Readable forms of a Hub fingerprint (spec 005 data-model "Hub"): 8 groups of 4 base32 characters, and 4 words. */

export const WORDLIST: readonly string[] = [
  'acorn', 'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'badge',
  'bagel', 'baker', 'bamboo', 'banjo', 'barley', 'basil', 'beacon', 'beaver',
  'berry', 'bison', 'blanket', 'blossom', 'bonnet', 'border', 'bottle', 'branch',
  'breeze', 'bridge', 'bronze', 'brook', 'bubble', 'bucket', 'button', 'cabin',
  'cactus', 'camel', 'candle', 'canoe', 'canyon', 'carbon', 'carpet', 'castle',
  'cedar', 'cherry', 'chimney', 'circle', 'clover', 'cobalt', 'comet', 'copper',
  'coral', 'cotton', 'coyote', 'crater', 'cricket', 'crystal', 'cupboard', 'curtain',
  'daisy', 'dagger', 'delta', 'desert', 'dingo', 'dolphin', 'domino', 'dragon',
  'drift', 'eagle', 'ember', 'engine', 'falcon', 'feather', 'fennel', 'fiddle',
  'finch', 'flame', 'flint', 'forest', 'fossil', 'fountain', 'gadget', 'garden',
  'garlic', 'geyser', 'ginger', 'glacier', 'glove', 'goblet', 'granite', 'grove',
  'guitar', 'hammer', 'harbor', 'hazel', 'heron', 'hickory', 'hollow', 'honey',
  'horizon', 'hornet', 'iceberg', 'igloo', 'island', 'ivory', 'jacket', 'jaguar',
  'jasmine', 'jigsaw', 'jungle', 'kettle', 'kayak', 'kernel', 'kitten', 'ladder',
  'lagoon', 'lantern', 'laurel', 'lemon', 'lentil', 'lilac', 'lizard', 'lobster',
  'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mirror', 'mitten',
  'monsoon', 'mosaic', 'mustard', 'nectar', 'needle', 'nickel', 'nutmeg', 'oasis',
  'ocean', 'olive', 'onyx', 'orchid', 'otter', 'oyster', 'paddle', 'pebble',
  'pepper', 'pillow', 'pine', 'planet', 'plum', 'pocket', 'poplar', 'prairie',
  'pumpkin', 'puzzle', 'quartz', 'quiver', 'rabbit', 'radish', 'raven', 'reef',
  'ribbon', 'river', 'rocket', 'saddle', 'saffron', 'salmon', 'sandal', 'sapphire',
  'satchel', 'scarlet', 'shadow', 'shell', 'silver', 'sketch', 'skylark', 'slate',
  'sparrow', 'spice', 'spruce', 'squirrel', 'stable', 'summit', 'sunset', 'swallow',
  'tangerine', 'teapot', 'thistle', 'thunder', 'timber', 'tiger', 'topaz', 'tunnel',
  'turnip', 'umbrella', 'valley', 'velvet', 'violin', 'walnut', 'walrus', 'wander',
  'willow', 'window', 'winter', 'wizard', 'yarrow', 'zebra', 'zephyr', 'zinc',
  'anvil', 'bishop', 'cobble', 'dune', 'elm', 'fable', 'gravel', 'harvest',
  'iris', 'jetty', 'koala', 'lotus', 'mallet', 'nomad', 'opal', 'pewter',
  'quill', 'rhubarb', 'sorrel', 'tundra', 'urchin', 'vessel', 'wagon', 'yodel',
  'zenith', 'almond', 'bobbin', 'cinder', 'dahlia', 'emerald', 'figment', 'gazelle',
  'hearth', 'indigo', 'juniper', 'kestrel', 'lupine', 'marmot', 'nutshell', 'obsidian',
  'pelican', 'quince', 'rowan', 'sequoia', 'thimble', 'upland', 'vortex', 'wicker',
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** The first 20 bytes as 32 base32 characters in 8 groups of 4, joined by `-`. Needs at least 20 bytes. */
export function fingerprintGroups(fp: Uint8Array): string {
  if (fp.length < 20) throw new RangeError('fingerprint must be at least 20 bytes');
  let bits = 0;
  let acc = 0;
  let out = '';
  for (let i = 0; i < 20; i++) {
    acc = (acc << 8) | fp[i]!;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join('-');
}

/** The first 4 bytes as 4 words (32 bits), easy to compare aloud. */
export function fingerprintWords(fp: Uint8Array): string[] {
  if (fp.length < 4) throw new RangeError('fingerprint must be at least 4 bytes');
  return [0, 1, 2, 3].map((i) => WORDLIST[fp[i]!]!);
}
