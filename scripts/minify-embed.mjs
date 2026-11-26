// Minifies the browser embed script (worker/src/public/embed.client.js) for the deployed worker.
// Shared by scripts/build-worker.mjs and the tests that check the bundle, so both agree on the exact output.
import { transformSync } from "esbuild";

/** @param {string} source @returns {string} */
export function minifyEmbed(source) {
  return transformSync(source, {
    minify: true,
    target: "es2017",
    legalComments: "none",
    banner: "/* femtocms embed */",
  }).code;
}
