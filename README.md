# PNG Squeeze — smallest lossless PNG

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/vora95/makefun-png-squeeze-01-run-20261127-burn-2/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/vora95/makefun-png-squeeze-01-run-20261127-burn-2/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for [Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/bounty/png-squeeze-01-run-20261127) ($100, top 50 share the prize).

## What it does

`main.ts` (Node 22, standard library only) reads each `image.png` (1280×720 RGBA)
from `/input/<id>/` and writes the same image, losslessly, as small as possible
to `/output/<id>/image.png`.

## The idea

The win is in the DEFLATE stream, not the filters. For each image the program:

1. Decodes the stored PNG and analyses it (opaque? grey? ≤ 256 colours? a single
   transparent key?) to pick candidate colour forms: palette (by count or by
   luminance), grey, grey+alpha, RGB or RGBA, with a tRNS key where it holds.
2. Tries several filter strategies per form (fixed filters, minimum-sum,
   fewest-pairs, and a brute-force per-row choice scored by real deflate cost
   against the 32 KiB before it) and screens them with zlib.
3. Compresses the winner with a hand-written **optimal-parsing DEFLATE**:
   hash-chain match finding (longest match plus the best match within
   distance 1024), a shortest-path DP over literals/matches under the block's
   Huffman costs, three Huffman iterations, and blocks split at row
   boundaries near 512 KiB. Long matches (≥ 96) are forced greedily so the DP
   stays fast. A symbol the previous iteration never used is costed at 15
   bits, never treated as free.
4. Keeps the smaller of its own stream and zlib level 9 on the same filtered
   bytes, and writes a minimal PNG (IHDR, PLTE, tRNS, IDAT, IEND only).

A per-image failure falls back to copying the input, so one bad instance
never kills the set. Output is deterministic: the same bytes on every run.

## Local result (practice set, kit checker)

| instance | theme | bytes | points |
|----------|-------|------:|-------:|
| i001 | flat | 12,496 | 718.4 |
| i002 | rich | 52,273 | 700.4 |
| i003 | alpha | 100,771 | 710.7 |
| i004 | grey | 101,216 | 722.8 |
| i005 | flat | 16,552 | 742.3 |
| i006 | rich | 171,412 | 716.6 |
| i007 | alpha | 60,890 | 701.9 |
| i008 | grey | 24,900 | 714.1 |

**Total 715,886** (mean 715.9 points) — above the kit scale compressor
(666,667) and the house fixed-paeth baseline (420,399). All 8 instances
valid and pixel-exact. Runs in ~25 s for the whole set, inside the 60 s limit.

## Run it

```sh
node main.ts
# reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR (default /output)
```

## License

MIT — see [LICENSE](LICENSE).
