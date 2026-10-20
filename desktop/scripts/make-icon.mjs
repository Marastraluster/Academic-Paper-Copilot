import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import pngToIcoImport from "png-to-ico";

// Regenerates the Windows icon from the one logo the project already ships, so
// there is exactly one place a brand change has to happen.
//
// sharp renders the SVG (it bundles librsvg), and the ICO carries every size
// Windows asks for: 16/24/32 in the taskbar and Explorer's small views, 48 for
// medium icons, 256 for large ones and the installer.
//
// It writes to `desktop/assets/`, not `desktop/build/`: the repository ignores
// every `build/` directory (Python and frontend artefacts), and a file the build
// depends on must not be invisible to git.

const pngToIco = pngToIcoImport.default ?? pngToIcoImport;

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const desktopDir = path.resolve(here, "..");
const svg = path.join(desktopDir, "..", "assets", "logo.svg");
const outDir = path.join(desktopDir, "assets");
const sizes = [256, 128, 64, 48, 32, 24, 16];

await fs.mkdir(outDir, { recursive: true });

const render = (size) =>
  sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

const buffers = [];
for (const size of sizes) buffers.push(await render(size));

await fs.writeFile(path.join(outDir, "icon.ico"), await pngToIco(buffers));
await fs.writeFile(path.join(outDir, "icon.png"), await render(512));

console.log(`icon.ico + icon.png written to ${outDir}`);
