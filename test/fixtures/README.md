# Test fixtures

## `test-font.ttf`

A glyph subset of **Noto Sans Regular** (Google, version 2.007), reduced to
the printable ASCII range (`U+0020`–`U+007E`) so the test suite has a small,
always-present real TrueType font — no dependence on whatever fonts happen to
be installed on the machine running the tests.

Noto Sans is licensed under the **SIL Open Font License 1.1** (see `OFL.txt`),
which permits redistribution of subsets/derivatives. Noto fonts carry **no
Reserved Font Names**, so this subset keeps the original `Noto Sans` name in
its `name` table; the copyright and license records are preserved as well.

Regenerate with [`subset-font`](https://github.com/papandreou/subset-font)
(a dev dependency):

```js
import subsetFont from 'subset-font';
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('NotoSans-Regular.ttf'); // the upstream Noto Sans
let charset = '';
for (let c = 0x20; c <= 0x7e; c++) charset += String.fromCharCode(c);

writeFileSync(
  'test-font.ttf',
  await subsetFont(src, charset, {
    targetFormat: 'truetype',
    preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14],
    noLayoutClosure: true,
  }),
);
```
