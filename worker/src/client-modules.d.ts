// Files matching *.client.js are bundled as text (see `rules` in wrangler.jsonc) and imported as strings.
declare module "*.client.js" {
  const source: string;
  export default source;
}
