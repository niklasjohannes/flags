# Country & flag data

`data/countries.json` and `flags/<code>.svg` are generated, not hand-edited. This file explains where they come from, the rules that decide what is in them, and how to rebuild them. The same rules are embedded in machine-readable form in `countries.json` → `meta.policy`, because JSON can't carry comments.

## Files

| Path | What it is | Edited by hand? |
|---|---|---|
| `vendor/flag-icons/country.json` | flag-icons' own code list, copied verbatim from the pinned release | No |
| `vendor/flag-icons/LICENSE` | flag-icons' MIT license, verbatim | No |
| `scripts/country-overrides.js` | Our enrichment: names, aliases, region, sovereignty, parent, exclusions, policy text, source pin | **Yes**, this is the only file to edit |
| `scripts/build-countries.js` | Zero-dependency generator | Rarely |
| `scripts/svg-safety.js` | Static SVG safety check, shared by the generator and the tests | Rarely |
| `data/countries.json` | Generated output, served to the app | No |
| `flags/<code>.svg` | Vendored flag-icons 4x3 SVGs, one per entry, unmodified | No |

## Source pin

- flag-icons **v7.5.0**, commit `7aa5b2bdddd570ece62c812c0cb588ccdc099e2e` (annotated tag object `50a8bff005239b0d2d661254094dedb9c75dbef3`)
- Archive: `https://codeload.github.com/lipis/flag-icons/tar.gz/refs/tags/v7.5.0`, sha256 `5502d1bb0bda9f258d726d3c084a2d57a07cfdfa6d2ed18cbb5a1ee11b307778`
- We chose v7.5.0 (May 2025) over v7.6.0 (October 2026). v7.6.0 was 12 days old when we vendored, so we went with the release that has been in use for over a year.

## Shape

```json
{
  "meta": {
    "source": { "name": "flag-icons", "tag": "v7.5.0", "commit": "…", "archiveSha256": "…", "…": "…" },
    "regions": ["africa", "asia", "europe", "north-america", "south-america", "oceania"],
    "policy": { "scope": "…", "regionBasis": "…", "transcontinental": {}, "sovereignty": "…", "parentCode": "…", "naming": "…", "contested": {}, "duplicateFlags": "…" },
    "excluded": { "aq": "uninhabited: …", "…": "…" }
  },
  "countries": [
    { "code": "pr", "name": "Puerto Rico", "aliases": [], "region": "north-america", "sovereign": false, "parentCode": "us" }
  ]
}
```

`countries` is sorted by `code`. `code` and `parentCode` are lowercase ISO 3166-1 alpha-2, matching `flags/<code>.svg` exactly.

## Scope: which codes are in

1. Start from flag-icons' `country.json` (271 entries) and keep only `iso: true` (249 ISO 3166-1 codes). This removes subdivisions (`gb-eng`, `es-ct`, …), supranational/organisation flags (`eu`, `un`, `arab`, `asean`, …), placeholders (`xx`) and **Kosovo (`xk`)**, which has no ISO 3166-1 code. Kosovo is excluded by this mechanical rule, not by any judgement about its status.
2. Drop territories with **no permanent population**: `aq`, `bv`, `gs`, `hm`, `io`, `tf`, `um`.
3. Drop territories for which flag-icons ships **the parent state's flag**, because the quiz could not tell the two apart: `bl`, `gf`, `gp`, `mf`, `pm`, `re`, `wf`, `yt` (flag of France), `bq` (Netherlands), `sh` (United Kingdom), `sj` (Norway, differing only in colour shade). A test (`ships no two flags that are identical apart from their ids`) guards against this coming back.

Result: **231 entries**, 195 of them sovereign. Every dropped ISO code and its reason is listed in `meta.excluded`.

| Region | Entries | Sovereign |
|---|---:|---:|
| africa | 55 | 54 |
| asia | 51 | 48 |
| europe | 50 | 44 |
| north-america | 36 | 23 |
| south-america | 13 | 12 |
| oceania | 26 | 14 |

South America and Oceania are the small pools for multiple-choice distractors. Once parent/sibling exclusion is applied (spec #3), Oceania leaves 14 sovereign states and 12 territories, with `au`, `nz`, `us`, `fr` and `gb` as parents.

## Regions: closed taxonomy

`africa`, `asia`, `europe`, `north-america`, `south-america`, `oceania`. Nothing else is allowed. The tests enforce this.

**Basis: the UN M49 geoscheme** (UN Statistics Division, "Standard country or area codes for statistical use"). It is a published neutral standard, so placement is never our own judgement. M49's Africa, Asia, Europe and Oceania map 1:1. M49's Americas is split: Northern America, Central America and the Caribbean go to `north-america`, and South America goes to `south-america`. The `continent` field in flag-icons' upstream list is ignored.

Transcontinental and commonly surprising placements (all straight from M49):

| Code | Region | M49 sub-region |
|---|---|---|
| `ru` Russia | europe | Eastern Europe |
| `tr` Türkiye | asia | Western Asia |
| `cy` Cyprus | asia | Western Asia (although an EU member) |
| `am` `az` `ge` Caucasus | asia | Western Asia |
| `kz` Kazakhstan | asia | Central Asia |
| `eg` Egypt | africa | Northern Africa |
| `id` Indonesia, `tl` Timor-Leste | asia | South-eastern Asia |
| `pg` Papua New Guinea | oceania | Melanesia |
| `pa` Panama | north-america | Central America |
| `tt` Trinidad and Tobago, `aw` Aruba, `cw` Curaçao | north-america | Caribbean (upstream says South America) |
| `gl` Greenland | north-america | Northern America |
| `cx` Christmas Island, `cc` Cocos (Keeling) Islands | oceania | Australia and New Zealand (upstream says Asia) |
| `tw` Taiwan | asia | not listed in M49; placed by geography (Eastern Asia) |

## Sovereignty and parents

- **`sovereign: true` if and only if** the entry is a UN member state (193) or a UN non-member observer state (`ps` Palestine, `va` Vatican City). Everything else is `false`. No other recognition judgement is made.
- **`parentCode`** is the single UN-member state that de facto administers a dependency/territory. Cook Islands and Niue are in free association with New Zealand, so their parent is `nz`. It is `null` for sovereign entries, and for non-sovereign entries whose own status is disputed with no single administering state (`tw`, `eh`). A sovereignty *claim* by a third state doesn't change `parentCode`. The field records administration, not legitimacy.
- The purpose of `parentCode` in the app is to stop multiple-choice questions from pairing a territory with its parent or siblings (spec #3).

## Naming

- `name` is the common English short name, with no political qualifiers and with diacritics kept (`Côte d'Ivoire`, `Türkiye`, `Curaçao`, `Åland Islands`, `São Tomé and Príncipe`).
- `aliases` are former, long-form or colloquial English names for typing-mode search only (e.g. Netherlands → "Holland", United States → "USA", "US", "United States of America", "America", Czechia → "Czech Republic", Myanmar → "Burma", Eswatini → "Swaziland", Côte d'Ivoire → "Ivory Coast", and an ASCII spelling wherever `name` has diacritics). An alias is a search aid, not an endorsement. Matching (case/diacritic folding, typo tolerance) is spec #3's job.

## Contested and sensitive entries

| Code | Treatment |
|---|---|
| `tw` Taiwan | Not a UN member or observer → `sovereign: false`. Disputed status, no single administering UN member → `parentCode: null`. Name "Taiwan", no aliases. Region asia (geography; not in M49). |
| `eh` Western Sahara | Non-self-governing territory, administration divided → `sovereign: false`, `parentCode: null`. Name "Western Sahara", no aliases. |
| `ps` Palestine | UN observer state → `sovereign: true`. Name "Palestine", alias "State of Palestine". |
| `va` Vatican City | UN observer state (as the Holy See) → `sovereign: true`. Aliases "Holy See", "Vatican". |
| `xk` Kosovo | No ISO 3166-1 code → excluded by the scope rule. |
| `fk` Falkland Islands | UK-administered, claimed by Argentina → `parentCode: gb`. Aliases "Falklands" and "Malvinas", following the UN name "Falkland Islands (Malvinas)". |
| `gi` Gibraltar | UK-administered, claimed by Spain → `parentCode: gb`. |
| `hk` Hong Kong, `mo` Macau | Special administrative regions of China → `sovereign: false`, `parentCode: cn`. |
| `ck` Cook Islands, `nu` Niue | Free association with New Zealand, not UN members → `sovereign: false`, `parentCode: nz`. |
| `cy` Cyprus | One entry for the UN member state. Northern Cyprus has no ISO code and isn't in the source. |
| `io` British Indian Ocean Territory | Excluded for having no permanent population, independent of the Mauritius–UK sovereignty question. |

## Known look-alikes (kept)

Some genuinely distinct sovereign flags are near-identical: Chad/Romania, Indonesia/Monaco, and Ireland/Côte d'Ivoire (mirror images). These are real flag knowledge and are kept. Only territories that ship *their parent's* flag are dropped.

## SVG safety

Every vendored SVG is checked, at vendoring time by the generator and on every CI run by `test/countries.test.js`. A file fails if it has any of: `<script`, an `on*=` event-handler attribute, `<foreignObject`, an external `href`/`xlink:href` (`http:`, `https:`, `//`), a `javascript:`/`data:` href, an external `url(…)`, a CSS `@import`, or a `DOCTYPE`/`ENTITY` declaration. Internal fragment references (`href="#a"`, `url(#g)`) are allowed. All 231 v7.5.0 files passed unmodified. None were edited or excluded for safety reasons.

## Rebuilding

To change names, aliases, regions or policy, edit `scripts/country-overrides.js`, then:

```bash
node scripts/build-countries.js
node --test
```

The reproducibility test fails if `data/countries.json` isn't exactly what the generator produces, so you can't forget to commit the regenerated file.

To upgrade or re-vendor flag-icons (the only step that needs network access). Treat the download as untrusted data: never run `npm`, `yarn` or any script from it.

```bash
TAG=v7.5.0
mkdir -p .vendor-tmp/x                       # gitignored scratch dir
curl -sSL -o .vendor-tmp/flag-icons.tar.gz "https://codeload.github.com/lipis/flag-icons/tar.gz/refs/tags/$TAG"
shasum -a 256 .vendor-tmp/flag-icons.tar.gz  # record in SOURCE.archiveSha256
gzip -dc .vendor-tmp/flag-icons.tar.gz | git get-tar-commit-id   # record in SOURCE.commit
tar -xzf .vendor-tmp/flag-icons.tar.gz -C .vendor-tmp/x
cp .vendor-tmp/x/flag-icons-*/country.json .vendor-tmp/x/flag-icons-*/LICENSE vendor/flag-icons/
node scripts/build-countries.js --flags-from .vendor-tmp/x/flag-icons-*/flags/4x3
rm -rf .vendor-tmp
node --test
```

If the new release adds ISO codes, the generator stops and lists them until each one is added to `ENTRIES` or `EXCLUDED` in `scripts/country-overrides.js`. Also update `SOURCE`, this file's pin section and `THIRD_PARTY_NOTICES.md`.
