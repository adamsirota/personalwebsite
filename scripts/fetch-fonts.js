/**
 * One-off build helper: downloads the latin woff2 subsets for the three
 * typefaces into fonts/ so the site makes no third-party font request.
 * Run with `node scripts/fetch-fonts.js` if the font set ever changes.
 */
const fs = require("fs");
const path = require("path");

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FAMILIES = [
    { file: "fraunces", css: "Fraunces:opsz,wght@9..144,400..700" },
    { file: "instrument-sans", css: "Instrument+Sans:wght@400..600" },
    { file: "plex-mono", css: "IBM+Plex+Mono:wght@400;500" }
];

const outDir = path.join(__dirname, "..", "fonts");

async function main() {
    fs.mkdirSync(outDir, { recursive: true });

    for (const family of FAMILIES) {
        const url = `https://fonts.googleapis.com/css2?family=${family.css}&display=swap`;
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`CSS fetch failed for ${family.file}: ${res.status}`);
        const css = await res.text();

        // Keep only the latin block (the last unicode-range group Google emits).
        const blocks = css.split("@font-face").filter((b) => b.includes("unicode-range"));
        const latin = blocks.filter((b) => b.includes("U+0000-00FF"));
        const chosen = latin.length ? latin : blocks.slice(-1);

        let index = 0;
        for (const block of chosen) {
            const match = block.match(/url\((https:[^)]+\.woff2)\)/);
            if (!match) continue;
            const styleMatch = /font-style:\s*italic/.test(block) ? "italic" : "normal";
            const name = `${family.file}${styleMatch === "italic" ? "-italic" : ""}${index ? `-${index}` : ""}.woff2`;
            const fontRes = await fetch(match[1], { headers: { "User-Agent": UA } });
            if (!fontRes.ok) throw new Error(`Font fetch failed for ${name}: ${fontRes.status}`);
            const buffer = Buffer.from(await fontRes.arrayBuffer());
            fs.writeFileSync(path.join(outDir, name), buffer);
            console.log(`${name}  ${(buffer.length / 1024).toFixed(1)} KB`);
            index += 1;
        }
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
